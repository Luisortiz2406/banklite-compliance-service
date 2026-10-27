import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { AdminAudit } from '../common/staff/admin-audit.entity';
import { AdminAuditService } from '../common/staff/admin-audit.service';
import { StaffPrincipal } from '../common/staff/staff-auth.guard';
import { ENTITIES } from '../entities';
import { createTestDatabase, describeWithDb, truncateAll } from '../testing/test-database';
import { CLOSURE_ALERT_WINDOW_DAYS, ComplianceService } from './compliance.service';
import { ComplianceClosure } from './entities/compliance-closure.entity';
import { SuspiciousActivityReport } from './entities/suspicious-activity-report.entity';

const DAY_MS = 24 * 60 * 60 * 1000;
const ANA = '11111111-1111-4111-8111-111111111111';
const CARLOS = '22222222-2222-4222-8222-222222222222';
const ACCOUNT = '3a000000-0000-4000-8000-000000000001';
const CLOSED_AT = new Date('2026-10-20T15:00:00.000Z');
const staff: StaffPrincipal = { id: 'staff-1', username: 'oficial', role: 'compliance' } as StaffPrincipal;

let txCounter = 0;
const nextTx = () => `7b000000-0000-4000-8000-${String(++txCounter).padStart(12, '0')}`;

describeWithDb('Cierres de cuenta en compliance (PostgreSQL)', () => {
  let dataSource: DataSource;
  let drop: () => Promise<void>;
  let compliance: ComplianceService;

  beforeAll(async () => {
    ({ dataSource, drop } = await createTestDatabase('compliance', ENTITIES));
    const config = { get: (_key: string, fallback?: string) => fallback } as unknown as ConfigService;
    compliance = new ComplianceService(dataSource, config, new AdminAuditService(dataSource.getRepository(AdminAudit)));
  });
  afterAll(() => drop());
  beforeEach(() => truncateAll(dataSource));

  const closures = () => dataSource.getRepository(ComplianceClosure);
  const close = (idUser = ANA, closedAt = CLOSED_AT) =>
    compliance.handleAccountClosed({ idUser, closedAt, accounts: ['4001234567'] });

  /** Alerta de fraude (como la proyecta compliance) con la fecha que se le indique. */
  async function fraudAlert(idUser: string, createdAt?: Date) {
    const transactionId = nextTx();
    await compliance.handleFraudAlert({ idUser, accountId: ACCOUNT, transactionId, score: 85, reason: 'Monto alto' });
    if (createdAt)
      await dataSource.query('UPDATE suspicious_activity_reports SET created_at = $1 WHERE transaction_id = $2', [
        createdAt,
        transactionId,
      ]);
  }

  it('registra el cierre sin alertas: no queda por revisar', async () => {
    await close();
    const row = await closures().findOneByOrFail({ idUser: ANA });
    expect(row.closedAt.toISOString()).toBe(CLOSED_AT.toISOString());
    expect(row.accounts).toEqual(['4001234567']);
    expect(row.recentAlerts).toBe(0);
    expect(row.requiresReview).toBe(false);
  });

  it('el evento repetido o simultáneo crea un solo registro', async () => {
    await Promise.all(Array.from({ length: 5 }, () => close()));
    await close();
    expect(await closures().count()).toBe(1);
  });

  it(`cuenta las alertas desde ${CLOSURE_ALERT_WINDOW_DAYS} días antes del cierre, incluido el borde`, async () => {
    const windowStart = CLOSED_AT.getTime() - CLOSURE_ALERT_WINDOW_DAYS * DAY_MS;
    await fraudAlert(ANA, new Date(windowStart)); // justo en el borde: cuenta
    await fraudAlert(ANA, new Date(windowStart - 1000)); // un segundo antes: no cuenta
    await fraudAlert(ANA, new Date(CLOSED_AT.getTime() - DAY_MS)); // el día anterior: cuenta
    await close();
    const row = await closures().findOneByOrFail({ idUser: ANA });
    expect(row.recentAlerts).toBe(2);
    expect(row.requiresReview).toBe(true);
  });

  it('no cuenta alertas de otro cliente ni SAR de la regla de volumen', async () => {
    await fraudAlert(CARLOS, new Date(CLOSED_AT.getTime() - DAY_MS));
    await dataSource.getRepository(SuspiciousActivityReport).insert({
      idUser: ANA,
      accountId: ACCOUNT,
      transactionId: nextTx(),
      reason: 'Volumen acumulado',
      severity: 'medium',
      source: 'volume_rule',
      status: 'open',
    });
    await close();
    const row = await closures().findOneByOrFail({ idUser: ANA });
    expect(row.recentAlerts).toBe(0);
    expect(row.requiresReview).toBe(false);
  });

  it('no crea un SAR al cerrar (solo marca para revisión)', async () => {
    await fraudAlert(ANA, new Date(CLOSED_AT.getTime() - DAY_MS));
    await close();
    expect(await dataSource.getRepository(SuspiciousActivityReport).count()).toBe(1);
  });

  it('una alerta que llega después del cierre lo deja por revisar, aunque ya estuviera revisado', async () => {
    await fraudAlert(ANA, new Date(CLOSED_AT.getTime() - DAY_MS));
    await close();
    await compliance.markClosureReviewed(ANA, 'Revisado con el equipo de fraude', staff);

    await fraudAlert(ANA); // llega ahora, después del cierre
    const row = await closures().findOneByOrFail({ idUser: ANA });
    expect(row.recentAlerts).toBe(2);
    expect(row.requiresReview).toBe(true);
    expect(row.reviewedAt).toBeNull();
    expect(row.reviewedBy).toBeNull();
    // La revisión anterior sigue en la bitácora.
    expect(await dataSource.getRepository(AdminAudit).count({ where: { action: 'closure.reviewed' } })).toBe(1);
  });

  it('la misma alerta repetida después del cierre no suma dos veces', async () => {
    await close();
    const transactionId = nextTx();
    const alert = { idUser: ANA, accountId: ACCOUNT, transactionId, score: 70, reason: 'Repetida' };
    await compliance.handleFraudAlert(alert);
    await compliance.handleFraudAlert(alert);
    expect((await closures().findOneByOrFail({ idUser: ANA })).recentAlerts).toBe(1);
  });

  it('una alerta y el cierre al mismo tiempo: la alerta siempre se cuenta una vez', async () => {
    for (let i = 0; i < 10; i++) {
      await truncateAll(dataSource);
      await Promise.all([close(ANA, new Date()), fraudAlert(ANA)]);
      const row = await closures().findOneByOrFail({ idUser: ANA });
      expect(row.recentAlerts).toBe(1);
      expect(row.requiresReview).toBe(true);
    }
  });

  describe('Marcar revisado', () => {
    it('guarda quién, cuándo y el motivo, y lo registra en la bitácora', async () => {
      await fraudAlert(ANA, new Date(CLOSED_AT.getTime() - DAY_MS));
      await close();
      const result = await compliance.markClosureReviewed(ANA, '  Sin hallazgos  ', staff);
      expect(result && 'closure' in result).toBe(true);

      const row = await closures().findOneByOrFail({ idUser: ANA });
      expect(row.reviewedBy).toBe('oficial');
      expect(row.reviewedAt).toBeInstanceOf(Date);
      expect(row.reviewNote).toBe('Sin hallazgos');

      const audit = await dataSource.getRepository(AdminAudit).find();
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        staffUsername: 'oficial',
        staffRole: 'compliance',
        action: 'closure.reviewed',
        targetType: 'compliance_closure',
        targetId: ANA,
        reason: 'Sin hallazgos',
      });
    });

    it('no se puede marcar dos veces ni marcar un cierre que no requiere revisión', async () => {
      await close(CARLOS);
      expect(await compliance.markClosureReviewed(CARLOS, 'No aplica aquí', staff)).toEqual({
        conflict: 'Este cierre no requiere revisión.',
      });

      await fraudAlert(ANA, new Date(CLOSED_AT.getTime() - DAY_MS));
      await close();
      await compliance.markClosureReviewed(ANA, 'Primera revisión', staff);
      expect(await compliance.markClosureReviewed(ANA, 'Segunda revisión', staff)).toEqual({
        conflict: 'Este cierre ya fue revisado por oficial.',
      });
      expect(await dataSource.getRepository(AdminAudit).count()).toBe(1);
    });

    it('un cliente sin cierre devuelve null', async () => {
      expect(await compliance.markClosureReviewed(ANA, 'No existe', staff)).toBeNull();
    });
  });

  describe('Listado, detalle e indicadores', () => {
    beforeEach(async () => {
      await fraudAlert(ANA, new Date(CLOSED_AT.getTime() - DAY_MS));
      await close(ANA);
      await close(CARLOS, new Date('2026-10-25T10:00:00.000Z'));
    });

    it('filtra por revisar, revisados y todos', async () => {
      expect((await compliance.listClosures('todos')).total).toBe(2);
      expect((await compliance.listClosures('por_revisar')).items.map((c) => c.idUser)).toEqual([ANA]);
      expect((await compliance.listClosures('revisados')).total).toBe(0);

      await compliance.markClosureReviewed(ANA, 'Sin hallazgos', staff);
      expect((await compliance.listClosures('por_revisar')).total).toBe(0);
      expect((await compliance.listClosures('revisados')).items.map((c) => c.idUser)).toEqual([ANA]);
    });

    it('el detalle trae las alertas de la ventana', async () => {
      const detail = await compliance.closureDetail(ANA);
      expect(detail?.alerts).toHaveLength(1);
      expect(detail?.alerts[0].source).toBe('fraud.alert');
      expect(await compliance.closureDetail('33333333-3333-4333-8333-333333333333')).toBeNull();
    });

    it('KPIs: cuentas cerradas del periodo (con bordes) y cierres por revisar', async () => {
      const kpis = await compliance.kpis(CLOSED_AT, new Date('2026-10-25T10:00:00.000Z'));
      expect(kpis.closedAccounts).toBe(2);
      expect(kpis.closuresPendingReview).toBe(1);

      const after = await compliance.kpis(new Date(CLOSED_AT.getTime() + 1), new Date('2026-10-25T09:59:59.999Z'));
      expect(after.closedAccounts).toBe(0);

      await compliance.markClosureReviewed(ANA, 'Sin hallazgos', staff);
      expect((await compliance.kpis(CLOSED_AT, CLOSED_AT)).closuresPendingReview).toBe(0);
    });

    it('el reporte AML guarda las cuentas cerradas del periodo', async () => {
      const report = await compliance.generateReport('2026-10-01', '2026-10-31', 'oficial');
      expect(report.payload).toMatchObject({ closedAccounts: 2, closuresPendingReview: 1 });
    });
  });
});
