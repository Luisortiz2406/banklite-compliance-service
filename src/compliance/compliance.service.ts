import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, MoreThanOrEqual, Not } from 'typeorm';
import { AdminAuditService } from '../common/staff/admin-audit.service';
import { StaffPrincipal } from '../common/staff/staff-auth.guard';
import { AmlReport } from './entities/aml-report.entity';
import { ComplianceAccount } from './entities/compliance-account.entity';
import { ComplianceClosure } from './entities/compliance-closure.entity';
import { ComplianceIdentity } from './entities/compliance-identity.entity';
import { ComplianceTransaction } from './entities/compliance-transaction.entity';
import { SuspiciousActivityReport } from './entities/suspicious-activity-report.entity';

const DAY_MS = 24 * 60 * 60 * 1000;
const VOLUME_RULE_WINDOW_DAYS = 30;
// Un cierre queda para revisión si el cliente tuvo alertas de fraude desde estos días antes.
export const CLOSURE_ALERT_WINDOW_DAYS = 30;

export type ClosureFilter = 'por_revisar' | 'revisados' | 'todos';

/**
 * Proyecta los eventos del bus en las tablas propias de Compliance (nunca lee
 * la base de otro servicio, sección 4.10 del documento) y aplica la regla de
 * AML por volumen acumulado. El resto de endpoints (KPIs, SAR, reportes) lee
 * de estas mismas proyecciones.
 */
@Injectable()
export class ComplianceService {
  private readonly logger = new Logger('ComplianceService');

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly audit: AdminAuditService,
  ) {}

  async handleTransactionCompleted(payload: {
    idUser: string;
    direction: 'in' | 'out';
    transactionId: string;
    type: string;
    sourceAccountId: string | null;
    destinationAccountId: string | null;
    amount: number;
    currency: string;
    createdAt: string;
  }) {
    const accountId = payload.direction === 'out' ? payload.sourceAccountId : payload.destinationAccountId;
    if (!accountId) return;
    const occurredAt = new Date(payload.createdAt);

    await this.dataSource.transaction(async (manager) => {
      const txRepo = manager.getRepository(ComplianceTransaction);
      const existing = await txRepo.findOne({ where: { transactionId: payload.transactionId, accountId } });
      if (existing) return; // reentrega (at-least-once), ya proyectado

      await txRepo.save(
        txRepo.create({
          transactionId: payload.transactionId,
          accountId,
          idUser: payload.idUser,
          type: payload.type,
          direction: payload.direction,
          amount: String(payload.amount),
          currency: payload.currency,
          occurredAt,
        }),
      );

      if (payload.direction !== 'out') return;

      // Regla de AML propia: volumen de salida acumulado en una ventana larga (30 días).
      const windowStart = new Date(occurredAt.getTime() - VOLUME_RULE_WINDOW_DAYS * DAY_MS);
      const { sum } = await manager
        .createQueryBuilder(ComplianceTransaction, 'tx')
        .select('COALESCE(SUM(tx.amount), 0)', 'sum')
        .where('tx.accountId = :accountId', { accountId })
        .andWhere('tx.direction = :direction', { direction: 'out' })
        .andWhere('tx.occurredAt >= :windowStart', { windowStart })
        .getRawOne<{ sum: string }>();
      // La suma ya incluye la transacción actual (se guardó arriba): no se vuelve a sumar.
      const outflow30d = Number(sum);

      const threshold = Number(this.config.get('COMPLIANCE_AML_VOLUME_THRESHOLD', '50000000'));
      if (outflow30d <= threshold) return;

      const sarRepo = manager.getRepository(SuspiciousActivityReport);
      const alreadyOpen = await sarRepo.findOne({
        where: { accountId, source: 'volume_rule', status: 'open' },
      });
      if (alreadyOpen) return; // no duplicar mientras siga abierto

      await sarRepo.save(
        sarRepo.create({
          idUser: payload.idUser,
          accountId,
          transactionId: payload.transactionId,
          reason: `Volumen de salida acumulado de ${outflow30d.toFixed(2)} en los últimos ${VOLUME_RULE_WINDOW_DAYS} días (umbral ${threshold}).`,
          severity: 'medium',
          source: 'volume_rule',
          status: 'open',
        }),
      );
      this.logger.warn(`SAR generado por volumen acumulado para idUser=${payload.idUser} accountId=${accountId}`);
    });
  }

  async handleAccountCreated(payload: { idUser: string; email?: string; nombreCompleto?: string }) {
    await this.dataSource
      .getRepository(ComplianceAccount)
      .upsert(
        { idUser: payload.idUser, email: payload.email ?? null, nombreCompleto: payload.nombreCompleto ?? null },
        ['idUser'],
      );
  }

  async handleIdentityVerified(payload: { idUser: string }) {
    const repo = this.dataSource.getRepository(ComplianceIdentity);
    const existing = await repo.findOne({ where: { idUser: payload.idUser } });
    if (existing) {
      existing.verified = true;
      await repo.save(existing);
    } else {
      await repo.save(repo.create({ idUser: payload.idUser, verified: true, rejectedCount: 0 }));
    }
  }

  async handleIdentityRejected(payload: { idUser: string }) {
    const repo = this.dataSource.getRepository(ComplianceIdentity);
    const existing = await repo.findOne({ where: { idUser: payload.idUser } });
    if (existing) {
      existing.rejectedCount += 1;
      await repo.save(existing);
    } else {
      await repo.save(repo.create({ idUser: payload.idUser, verified: false, rejectedCount: 1 }));
    }
  }

  async handleFraudAlert(payload: {
    idUser: string;
    accountId: string;
    transactionId: string;
    score: number;
    reason: string;
  }) {
    await this.dataSource.transaction(async (manager) => {
      // Mismo bloqueo que el cierre: así una alerta y el cierre a la vez no se pierden de vista.
      await this.lockUser(manager, payload.idUser);
      const repo = manager.getRepository(SuspiciousActivityReport);
      const existing = await repo.findOne({
        where: { transactionId: payload.transactionId, accountId: payload.accountId, source: 'fraud.alert' },
      });
      if (existing) return; // reentrega
      const severity = payload.score >= 80 ? 'high' : payload.score >= 60 ? 'medium' : 'low';
      await repo.save(
        repo.create({
          idUser: payload.idUser,
          accountId: payload.accountId,
          transactionId: payload.transactionId,
          reason: `Alerta de Fraud Service (score ${payload.score}): ${payload.reason}`,
          severity,
          source: 'fraud.alert',
          status: 'open',
        }),
      );

      // Alerta que llega después del cierre: el cierre vuelve a quedar por revisar
      // (la revisión anterior queda en la bitácora del panel).
      const closures = manager.getRepository(ComplianceClosure);
      const closure = await closures.findOne({ where: { idUser: payload.idUser } });
      if (!closure) return;
      closure.recentAlerts += 1;
      closure.requiresReview = true;
      closure.reviewedBy = null;
      closure.reviewedAt = null;
      closure.reviewNote = null;
      await closures.save(closure);
      this.logger.warn(`Alerta de fraude después del cierre idUser=${payload.idUser}: el cierre queda por revisar.`);
    });
  }

  /**
   * Cliente que canceló su cuenta (evento account.closed). Registra el cierre una
   * sola vez y lo marca para revisión si tuvo alertas de fraude desde 30 días
   * antes del cierre. No crea un SAR: lo decide un empleado de cumplimiento.
   */
  async handleAccountClosed(payload: { idUser: string; closedAt: Date; accounts: string[] }) {
    await this.dataSource.transaction(async (manager) => {
      await this.lockUser(manager, payload.idUser);
      const closures = manager.getRepository(ComplianceClosure);
      if (await closures.exists({ where: { idUser: payload.idUser } })) {
        this.logger.log(`account.closed repetido para idUser=${payload.idUser}: el cierre ya estaba registrado.`);
        return;
      }
      // Sin límite superior: cuenta también las alertas que llegaron después del cierre
      // pero antes que este evento (las que lleguen más tarde las suma handleFraudAlert).
      const recentAlerts = await manager.getRepository(SuspiciousActivityReport).count({
        where: {
          idUser: payload.idUser,
          source: 'fraud.alert',
          createdAt: MoreThanOrEqual(this.alertWindowStart(payload.closedAt)),
        },
      });
      await closures.insert({
        idUser: payload.idUser,
        closedAt: payload.closedAt,
        accounts: payload.accounts,
        recentAlerts,
        requiresReview: recentAlerts > 0,
      });
      if (recentAlerts > 0)
        this.logger.warn(
          `Cierre de cuenta idUser=${payload.idUser} con ${recentAlerts} alerta(s) de fraude reciente(s): queda por revisar.`,
        );
      else this.logger.log(`Cierre de cuenta registrado idUser=${payload.idUser}.`);
    });
  }

  async listClosures(filter: ClosureFilter, page = 1, limit = 25) {
    const where =
      filter === 'por_revisar'
        ? { requiresReview: true, reviewedAt: IsNull() }
        : filter === 'revisados'
          ? { reviewedAt: Not(IsNull()) }
          : {};
    const [items, total] = await this.dataSource.getRepository(ComplianceClosure).findAndCount({
      where,
      order: { closedAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { items, total, page, limit };
  }

  /** Un cierre con las alertas de fraude que lo dejaron por revisar. */
  async closureDetail(idUser: string) {
    const closure = await this.dataSource.getRepository(ComplianceClosure).findOne({ where: { idUser } });
    if (!closure) return null;
    const alerts = await this.dataSource.getRepository(SuspiciousActivityReport).find({
      where: { idUser, source: 'fraud.alert', createdAt: MoreThanOrEqual(this.alertWindowStart(closure.closedAt)) },
      order: { createdAt: 'DESC' },
    });
    return { ...closure, alerts };
  }

  /** «Marcar revisado»: el cambio y su registro en la bitácora van en la misma transacción. */
  async markClosureReviewed(idUser: string, note: string, staff: StaffPrincipal) {
    return this.dataSource.transaction(async (manager) => {
      await this.lockUser(manager, idUser);
      const repo = manager.getRepository(ComplianceClosure);
      const closure = await repo.findOne({ where: { idUser } });
      if (!closure) return null;
      if (!closure.requiresReview) return { conflict: 'Este cierre no requiere revisión.' };
      if (closure.reviewedAt) return { conflict: `Este cierre ya fue revisado por ${closure.reviewedBy}.` };
      closure.reviewedBy = staff.username;
      closure.reviewedAt = new Date();
      closure.reviewNote = note.trim();
      await repo.save(closure);
      await this.audit.record(
        staff,
        {
          action: 'closure.reviewed',
          targetType: 'compliance_closure',
          targetId: idUser,
          reason: note,
          details: { recentAlerts: closure.recentAlerts, closedAt: closure.closedAt.toISOString() },
        },
        manager,
      );
      return { closure };
    });
  }

  private alertWindowStart(closedAt: Date) {
    return new Date(closedAt.getTime() - CLOSURE_ALERT_WINDOW_DAYS * DAY_MS);
  }

  private lockUser(manager: EntityManager, idUser: string) {
    return manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`compliance-closure:${idUser}`]);
  }

  /** KPIs de negocio para el periodo [from, to]. */
  async kpis(from: Date, to: Date) {
    const txRepo = this.dataSource.getRepository(ComplianceTransaction);
    const txCountRow = await txRepo
      .createQueryBuilder('tx')
      .select('COUNT(DISTINCT tx.transactionId)', 'count')
      .where('tx.occurredAt BETWEEN :from AND :to', { from, to })
      .getRawOne<{ count: string }>();
    const totalTransactions = Number(txCountRow?.count ?? 0);

    // Cada transferencia solo tiene un lado 'out'; los depósitos/créditos entran por el lado 'in'
    // (vienen de una cuenta del sistema que no se proyecta aquí), así que no se cuentan doble.
    const volumeRow = await txRepo
      .createQueryBuilder('tx')
      .select(
        "COALESCE(SUM(CASE WHEN tx.direction = 'out' OR tx.type IN ('credit', 'deposit') THEN tx.amount ELSE 0 END), 0)",
        'volume',
      )
      .where('tx.occurredAt BETWEEN :from AND :to', { from, to })
      .getRawOne<{ volume: string }>();
    const totalVolume = Number(volumeRow?.volume ?? 0);

    const newAccounts = await this.dataSource
      .getRepository(ComplianceAccount)
      .createQueryBuilder('a')
      .where('a.createdAt BETWEEN :from AND :to', { from, to })
      .getCount();

    const identityRepo = this.dataSource.getRepository(ComplianceIdentity);
    const verifiedCount = await identityRepo.count({ where: { verified: true } });
    const rejectedTotal = await identityRepo
      .createQueryBuilder('i')
      .select('COALESCE(SUM(i.rejectedCount), 0)', 'total')
      .getRawOne<{ total: string }>();
    const totalAttempts = verifiedCount + Number(rejectedTotal?.total ?? 0);
    const kycApprovalRate = totalAttempts > 0 ? Number(((verifiedCount / totalAttempts) * 100).toFixed(2)) : null;

    const sarRepo = this.dataSource.getRepository(SuspiciousActivityReport);
    const sarCount = await sarRepo
      .createQueryBuilder('s')
      .where('s.createdAt BETWEEN :from AND :to', { from, to })
      .getCount();
    const flaggedCount = await sarRepo
      .createQueryBuilder('s')
      .where('s.createdAt BETWEEN :from AND :to', { from, to })
      .andWhere("s.source = 'fraud.alert'")
      .getCount();
    const openSars = await sarRepo.count({ where: { status: 'open' } });

    const closureRepo = this.dataSource.getRepository(ComplianceClosure);
    const closedAccounts = await closureRepo
      .createQueryBuilder('c')
      .where('c.closedAt BETWEEN :from AND :to', { from, to })
      .getCount();
    // Como openSars, es el estado actual (no depende del periodo).
    const closuresPendingReview = await closureRepo.count({ where: { requiresReview: true, reviewedAt: IsNull() } });

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      totalTransactions,
      totalVolume,
      newAccounts,
      kycApprovalRate,
      sarCount,
      flaggedCount,
      openSars,
      closedAccounts,
      closuresPendingReview,
    };
  }

  /**
   * Genera y persiste el snapshot de un periodo (nombre literal `aml_reports`
   * del documento). Inmutable: una vez creado no se reescribe, consistente
   * con la filosofía ledger-first aplicada a los reportes de cumplimiento.
   */
  async generateReport(periodFrom: string, periodTo: string, generatedBy: string) {
    const from = new Date(`${periodFrom}T00:00:00.000Z`);
    const to = new Date(`${periodTo}T23:59:59.999Z`);
    const snapshot = await this.kpis(from, to);

    const repo = this.dataSource.getRepository(AmlReport);
    return repo.save(
      repo.create({
        periodFrom,
        periodTo,
        generatedBy,
        totalTransactions: snapshot.totalTransactions,
        totalVolume: String(snapshot.totalVolume),
        flaggedCount: snapshot.flaggedCount,
        sarCount: snapshot.sarCount,
        newAccounts: snapshot.newAccounts,
        kycApprovalRate: snapshot.kycApprovalRate !== null ? String(snapshot.kycApprovalRate) : null,
        payload: snapshot,
      }),
    );
  }

  async listReports(page = 1, limit = 25) {
    const repo = this.dataSource.getRepository(AmlReport);
    const [items, total] = await repo.findAndCount({
      order: { generatedAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { items, total, page, limit };
  }

  async reportDetail(id: string) {
    return this.dataSource.getRepository(AmlReport).findOne({ where: { id } });
  }

  async listSars(status?: string, severity?: string, page = 1, limit = 25) {
    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    if (severity) where.severity = severity;
    const repo = this.dataSource.getRepository(SuspiciousActivityReport);
    const [items, total] = await repo.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { items, total, page, limit };
  }

  async sarDetail(id: string) {
    return this.dataSource.getRepository(SuspiciousActivityReport).findOne({ where: { id } });
  }

  async resolveSar(id: string, status: 'filed' | 'dismissed', note: string, staffUsername: string) {
    const repo = this.dataSource.getRepository(SuspiciousActivityReport);
    const sar = await repo.findOne({ where: { id } });
    if (!sar) return null;
    if (sar.status !== 'open') return { conflict: true as const, sar };
    sar.status = status;
    sar.resolutionNote = note;
    sar.filedBy = staffUsername;
    sar.filedAt = status === 'filed' ? new Date() : null;
    await repo.save(sar);
    return { conflict: false as const, sar };
  }
}
