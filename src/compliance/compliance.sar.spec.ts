import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { AdminAudit } from '../common/staff/admin-audit.entity';
import { AdminAuditService } from '../common/staff/admin-audit.service';
import { ENTITIES } from '../entities';
import { createTestDatabase, describeWithDb, truncateAll } from '../testing/test-database';
import { ComplianceService } from './compliance.service';
import { ComplianceAccount } from './entities/compliance-account.entity';
import { ComplianceIdentity } from './entities/compliance-identity.entity';
import { ComplianceTransaction } from './entities/compliance-transaction.entity';
import { SuspiciousActivityReport } from './entities/suspicious-activity-report.entity';

/**
 * Proyección de eventos, regla de AML por volumen, SAR, KPIs y reportes contra PostgreSQL
 * real. Lo que importa: una reentrega nunca duplica nada, el SAR por volumen se abre una
 * sola vez mientras siga abierto, y un SAR resuelto no se vuelve a resolver.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const ANA = '11111111-1111-4111-8111-111111111111';
const CARLOS = '22222222-2222-4222-8222-222222222222';
const ACC_ANA = '3a000000-0000-4000-8000-000000000001';
const ACC_CARLOS = '3a000000-0000-4000-8000-000000000002';
const NOW = new Date('2026-11-11T15:00:00.000Z');

let counter = 0;
const txId = () => `7c000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;

describeWithDb('ComplianceService: proyecciones, SAR, KPIs y reportes (PostgreSQL)', () => {
  let dataSource: DataSource;
  let drop: () => Promise<void>;
  let compliance: ComplianceService;
  let env: Record<string, string>;

  beforeAll(async () => {
    ({ dataSource, drop } = await createTestDatabase('compliance_sar', ENTITIES));
    const config = { get: (key: string, fallback?: string) => env[key] ?? fallback } as unknown as ConfigService;
    compliance = new ComplianceService(dataSource, config, new AdminAuditService(dataSource.getRepository(AdminAudit)));
  });
  afterAll(() => drop?.());
  beforeEach(async () => {
    await truncateAll(dataSource);
    env = {};
  });

  const sars = () => dataSource.getRepository(SuspiciousActivityReport);
  const projected = () => dataSource.getRepository(ComplianceTransaction);
  const payload = (overrides: Record<string, unknown> = {}) => ({
    idUser: ANA,
    direction: 'out' as const,
    transactionId: txId(),
    type: 'transfer',
    sourceAccountId: ACC_ANA,
    destinationAccountId: ACC_CARLOS,
    amount: 1_000_000,
    currency: 'COP',
    createdAt: NOW.toISOString(),
    ...overrides,
  });

  describe('transacciones (transaction.completed)', () => {
    it('se proyecta en la cuenta del lado que corresponde: la de origen si sale, la de destino si entra', async () => {
      await compliance.handleTransactionCompleted(payload());
      await compliance.handleTransactionCompleted(payload({ direction: 'in', idUser: CARLOS }));

      const rows = await projected().find({ order: { direction: 'ASC' } });
      expect(rows.map((r) => [r.direction, r.accountId])).toEqual([
        ['in', ACC_CARLOS],
        ['out', ACC_ANA],
      ]);
      expect(rows[1]).toMatchObject({ type: 'transfer', currency: 'COP', idUser: ANA });
    });

    it('una reentrega no se proyecta dos veces ni vuelve a evaluar la regla', async () => {
      const event = payload({ amount: 60_000_000 });

      await compliance.handleTransactionCompleted(event);
      await compliance.handleTransactionCompleted(event);

      expect(await projected().count()).toBe(1);
      expect(await sars().count()).toBe(1);
    });

    it('un evento sin cuenta del lado correspondiente (por ejemplo una cuenta del sistema) se ignora', async () => {
      await compliance.handleTransactionCompleted(payload({ sourceAccountId: null }));
      await compliance.handleTransactionCompleted(payload({ direction: 'in', destinationAccountId: null }));

      expect(await projected().count()).toBe(0);
    });

    it('el mismo movimiento llega por emisor y receptor: cada uno se proyecta en su propia cuenta', async () => {
      const id = txId();
      await compliance.handleTransactionCompleted(payload({ transactionId: id }));
      await compliance.handleTransactionCompleted(payload({ transactionId: id, direction: 'in', idUser: CARLOS }));

      expect(await projected().countBy({ transactionId: id })).toBe(2);
    });
  });

  describe('regla de AML por volumen acumulado (30 días)', () => {
    it('no genera SAR por debajo o justo en el umbral (50.000.000 por defecto)', async () => {
      await compliance.handleTransactionCompleted(payload({ amount: 30_000_000 }));
      await compliance.handleTransactionCompleted(payload({ amount: 20_000_000 }));

      expect(await sars().count()).toBe(0);
    });

    it('al superar el umbral abre un SAR de severidad media, con el motivo y la transacción', async () => {
      await compliance.handleTransactionCompleted(payload({ amount: 30_000_000 }));
      const crossing = payload({ amount: 20_000_001 });

      await compliance.handleTransactionCompleted(crossing);

      const [sar] = await sars().find();
      expect(sar).toMatchObject({
        idUser: ANA,
        accountId: ACC_ANA,
        transactionId: crossing.transactionId,
        severity: 'medium',
        source: 'volume_rule',
        status: 'open',
      });
      expect(sar.reason).toContain('50000001.00');
      expect(sar.reason).toContain('umbral 50000000');
    });

    it('mientras el SAR siga abierto no se duplica; resuelto, el siguiente exceso abre otro', async () => {
      await compliance.handleTransactionCompleted(payload({ amount: 60_000_000 }));
      await compliance.handleTransactionCompleted(payload({ amount: 1_000_000 }));
      expect(await sars().count()).toBe(1);

      const [open] = await sars().find();
      await compliance.resolveSar(open.id, 'dismissed', 'Cliente justificó el movimiento', 'oficial');
      await compliance.handleTransactionCompleted(payload({ amount: 1_000_000 }));
      expect(await sars().count()).toBe(2);
    });

    it('solo cuentan las salidas de los últimos 30 días y de esa misma cuenta', async () => {
      await compliance.handleTransactionCompleted(
        payload({ amount: 45_000_000, createdAt: new Date(NOW.getTime() - 31 * DAY_MS).toISOString() }),
      );
      await compliance.handleTransactionCompleted(payload({ amount: 45_000_000, direction: 'in' })); // entrada: no suma
      await compliance.handleTransactionCompleted(
        payload({ amount: 45_000_000, idUser: CARLOS, sourceAccountId: ACC_CARLOS }),
      ); // otra cuenta

      await compliance.handleTransactionCompleted(payload({ amount: 10_000_000 }));

      expect(await sars().count()).toBe(0);
    });

    it('el umbral se puede configurar', async () => {
      env.COMPLIANCE_AML_VOLUME_THRESHOLD = '1000000';

      await compliance.handleTransactionCompleted(payload({ amount: 1_000_001 }));

      expect(await sars().count()).toBe(1);
    });
  });

  describe('alertas de fraude (fraud.alert)', () => {
    const alert = (score: number, overrides: Record<string, unknown> = {}) =>
      compliance.handleFraudAlert({
        idUser: ANA,
        accountId: ACC_ANA,
        transactionId: txId(),
        score,
        reason: 'Monto alto',
        ...overrides,
      });

    it('la severidad sale del puntaje: 80 o más alta, 60 a 79 media, menos de 60 baja', async () => {
      await alert(95);
      await alert(80);
      await alert(79);
      await alert(60);
      await alert(59);

      const bySeverity = (await sars().find({ order: { createdAt: 'ASC' } })).map((s) => s.severity);
      expect(bySeverity).toEqual(['high', 'high', 'medium', 'medium', 'low']);
      expect((await sars().find())[0]).toMatchObject({ source: 'fraud.alert', status: 'open' });
    });

    it('guarda el puntaje y el motivo, y una reentrega de la misma alerta no la duplica', async () => {
      const transactionId = txId();
      await alert(85, { transactionId, reason: 'Viaje imposible' });
      await alert(85, { transactionId, reason: 'Viaje imposible' });

      const [sar] = await sars().find();
      expect(await sars().count()).toBe(1);
      expect(sar.reason).toBe('Alerta de Fraud Service (score 85): Viaje imposible');
    });
  });

  describe('proyecciones de cuentas e identidad', () => {
    it('la cuenta creada guarda el correo y el nombre, y repetir el evento actualiza sin duplicar', async () => {
      await compliance.handleAccountCreated({ idUser: ANA, email: 'ana@banklite.test', nombreCompleto: 'Ana Pérez' });
      await compliance.handleAccountCreated({ idUser: ANA, email: 'nuevo@banklite.test' });

      const rows = await dataSource.getRepository(ComplianceAccount).find();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ email: 'nuevo@banklite.test', nombreCompleto: null });
    });

    it('cuenta las verificaciones y los rechazos de identidad por cliente', async () => {
      await compliance.handleIdentityRejected({ idUser: ANA });
      await compliance.handleIdentityRejected({ idUser: ANA });
      await compliance.handleIdentityVerified({ idUser: ANA });
      await compliance.handleIdentityVerified({ idUser: CARLOS });
      await compliance.handleIdentityRejected({ idUser: CARLOS });

      const identities = await dataSource.getRepository(ComplianceIdentity).find({ order: { idUser: 'ASC' } });
      expect(identities.map((i) => [i.verified, i.rejectedCount])).toEqual([
        [true, 2],
        [true, 1],
      ]);
    });
  });

  describe('SAR: listar, ver y resolver', () => {
    it('lista con filtros por estado y severidad, paginado, lo más reciente primero', async () => {
      await compliance.handleFraudAlert({
        idUser: ANA,
        accountId: ACC_ANA,
        transactionId: txId(),
        score: 90,
        reason: 'a',
      });
      await compliance.handleFraudAlert({
        idUser: ANA,
        accountId: ACC_ANA,
        transactionId: txId(),
        score: 10,
        reason: 'b',
      });

      expect((await compliance.listSars()).total).toBe(2);
      expect((await compliance.listSars('open', 'high')).items).toHaveLength(1);
      expect((await compliance.listSars('filed')).total).toBe(0);
      const page = await compliance.listSars(undefined, undefined, 2, 1);
      expect(page).toMatchObject({ page: 2, limit: 1, total: 2 });
      expect(page.items).toHaveLength(1);
    });

    it('resolver como presentado guarda quién y cuándo; como descartado no guarda fecha de presentación', async () => {
      await compliance.handleFraudAlert({
        idUser: ANA,
        accountId: ACC_ANA,
        transactionId: txId(),
        score: 90,
        reason: 'a',
      });
      await compliance.handleFraudAlert({
        idUser: ANA,
        accountId: ACC_ANA,
        transactionId: txId(),
        score: 90,
        reason: 'b',
      });
      const [first, second] = await sars().find({ order: { createdAt: 'ASC' } });

      const filed = await compliance.resolveSar(first.id, 'filed', 'Reportado a la UIAF', 'oficial');
      const dismissed = await compliance.resolveSar(second.id, 'dismissed', 'Falsa alarma', 'oficial');

      expect(filed).toMatchObject({
        conflict: false,
        sar: { status: 'filed', filedBy: 'oficial', resolutionNote: 'Reportado a la UIAF' },
      });
      expect((filed as any).sar.filedAt).toBeInstanceOf(Date);
      expect(dismissed).toMatchObject({ conflict: false, sar: { status: 'dismissed', filedAt: null } });
    });

    it('un SAR ya resuelto no se vuelve a resolver (conflicto) y uno inexistente devuelve null', async () => {
      await compliance.handleFraudAlert({
        idUser: ANA,
        accountId: ACC_ANA,
        transactionId: txId(),
        score: 90,
        reason: 'a',
      });
      const [sar] = await sars().find();
      await compliance.resolveSar(sar.id, 'filed', 'Reportado', 'oficial');

      expect(await compliance.resolveSar(sar.id, 'dismissed', 'Cambio de opinión', 'otro')).toMatchObject({
        conflict: true,
      });
      expect((await sars().findOneByOrFail({ id: sar.id })).status).toBe('filed');
      expect(await compliance.resolveSar('3a000000-0000-4000-8000-0000000000ff', 'filed', 'x', 'oficial')).toBeNull();
      expect(await compliance.sarDetail(sar.id)).toMatchObject({ id: sar.id });
    });
  });

  describe('KPIs y reportes', () => {
    const FROM = new Date('2026-11-01T00:00:00.000Z');
    const TO = new Date('2026-11-30T23:59:59.999Z');

    async function seed() {
      await compliance.handleTransactionCompleted(payload({ amount: 2_000_000, type: 'transfer' }));
      await compliance.handleTransactionCompleted(
        payload({ direction: 'in', idUser: CARLOS, amount: 2_000_000, type: 'transfer' }),
      );
      await compliance.handleTransactionCompleted(
        payload({ direction: 'in', idUser: ANA, amount: 5_000_000, type: 'deposit', destinationAccountId: ACC_ANA }),
      );
      await compliance.handleAccountCreated({ idUser: ANA, email: 'ana@banklite.test' });
      await compliance.handleIdentityVerified({ idUser: ANA });
      await compliance.handleIdentityVerified({ idUser: CARLOS });
      await compliance.handleIdentityRejected({ idUser: CARLOS });
      await compliance.handleFraudAlert({
        idUser: ANA,
        accountId: ACC_ANA,
        transactionId: txId(),
        score: 90,
        reason: 'a',
      });
    }

    it('cuenta transacciones del periodo, el volumen (salidas y abonos, sin contar dos veces cada transferencia), cuentas nuevas y SAR', async () => {
      await seed();
      await dataSource.query(`UPDATE compliance_accounts SET created_at = $1`, [new Date('2026-11-05T10:00:00Z')]);
      await dataSource.query(`UPDATE suspicious_activity_reports SET created_at = $1`, [
        new Date('2026-11-06T10:00:00Z'),
      ]);

      const kpis = await compliance.kpis(FROM, TO);

      expect(kpis).toMatchObject({
        totalTransactions: 3,
        totalVolume: 7_000_000, // la salida de 2M y el depósito de 5M; la entrada de la transferencia no se suma
        newAccounts: 1,
        kycApprovalRate: 66.67, // 2 verificadas de 3 intentos
        sarCount: 1,
        flaggedCount: 1,
        openSars: 1,
        closedAccounts: 0,
        closuresPendingReview: 0,
      });
      expect(kpis.from).toBe(FROM.toISOString());
    });

    it('lo que cae fuera del periodo no cuenta, y sin intentos de identidad la tasa de aprobación es nula', async () => {
      const kpis = await compliance.kpis(new Date('2020-01-01'), new Date('2020-01-31'));

      expect(kpis).toMatchObject({
        totalTransactions: 0,
        totalVolume: 0,
        newAccounts: 0,
        kycApprovalRate: null,
        sarCount: 0,
      });
    });

    it('el reporte guarda una foto de los KPIs del periodo y se puede listar y consultar', async () => {
      await seed();

      const report = await compliance.generateReport('2026-11-01', '2026-11-30', 'oficial');

      expect(report).toMatchObject({ periodFrom: '2026-11-01', periodTo: '2026-11-30', generatedBy: 'oficial' });
      expect(Number(report.totalVolume)).toBe(7_000_000);
      expect(Number(report.kycApprovalRate)).toBeCloseTo(66.67);
      expect((await compliance.listReports()).total).toBe(1);
      expect(await compliance.reportDetail(report.id)).toMatchObject({ id: report.id });
      expect(await compliance.reportDetail('3a000000-0000-4000-8000-0000000000ff')).toBeNull();
    });
  });
});
