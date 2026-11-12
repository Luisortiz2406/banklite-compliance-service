import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { AdminAudit } from '../common/staff/admin-audit.entity';
import { AdminAuditService } from '../common/staff/admin-audit.service';
import { ENTITIES } from '../entities';
import { createTestDatabase, describeWithDb, truncateAll } from '../testing/test-database';
import { ComplianceService } from './compliance.service';
import { SuspiciousActivityReport } from './entities/suspicious-activity-report.entity';

/**
 * Regresión: la regla de AML por volumen acumulado (umbral de 50.000.000 en 30 días)
 * contaba dos veces la transacción que se estaba evaluando (la consulta ya la incluía y
 * luego se le sumaba otra vez), así que abría SAR cuando el volumen real era menor al umbral.
 */
const ANA = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '3a000000-0000-4000-8000-000000000001';
const OTHER_ACCOUNT = '3a000000-0000-4000-8000-000000000002';
const THRESHOLD = 50_000_000;

let counter = 0;
const nextTx = () => `7d000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;

describeWithDb('Regla de volumen acumulado: la transacción actual cuenta una sola vez (PostgreSQL)', () => {
  let dataSource: DataSource;
  let drop: () => Promise<void>;
  let compliance: ComplianceService;

  beforeAll(async () => {
    ({ dataSource, drop } = await createTestDatabase('compliance_volumen', ENTITIES));
    const config = { get: (_key: string, fallback?: string) => fallback } as unknown as ConfigService;
    compliance = new ComplianceService(dataSource, config, new AdminAuditService(dataSource.getRepository(AdminAudit)));
  });
  afterAll(() => drop?.());
  beforeEach(() => truncateAll(dataSource));

  const sars = () => dataSource.getRepository(SuspiciousActivityReport).find();
  const outflow = (amount: number, overrides: Record<string, unknown> = {}) => ({
    idUser: ANA,
    direction: 'out' as const,
    transactionId: nextTx(),
    type: 'transfer',
    sourceAccountId: ACCOUNT,
    destinationAccountId: OTHER_ACCOUNT,
    amount,
    currency: 'COP',
    createdAt: new Date().toISOString(),
    ...overrides,
  });

  it('una sola salida por debajo del umbral no abre SAR', async () => {
    await compliance.handleTransactionCompleted(outflow(30_000_000));

    expect(await sars()).toHaveLength(0);
  });

  it('una sola salida justo en el umbral no abre SAR; un peso más sí, con el volumen real en el motivo', async () => {
    await compliance.handleTransactionCompleted(outflow(THRESHOLD));
    expect(await sars()).toHaveLength(0);

    await compliance.handleTransactionCompleted(outflow(1, { sourceAccountId: OTHER_ACCOUNT }));
    expect(await sars()).toHaveLength(0);

    const crossing = outflow(1);
    await compliance.handleTransactionCompleted(crossing);
    const [sar] = await sars();
    expect(sar).toMatchObject({ accountId: ACCOUNT, transactionId: crossing.transactionId, status: 'open' });
    expect(sar.reason).toContain('50000001.00'); // el volumen real, no el doble
  });

  it('varias salidas que suman justo el umbral no abren SAR; la que lo pasa por un peso sí', async () => {
    await compliance.handleTransactionCompleted(outflow(30_000_000));
    await compliance.handleTransactionCompleted(outflow(20_000_000));
    expect(await sars()).toHaveLength(0);

    await compliance.handleTransactionCompleted(outflow(1));
    const [sar] = await sars();
    expect(sar.reason).toContain('50000001.00');
  });

  it('una reentrega de la misma transacción no cambia el resultado', async () => {
    const event = outflow(30_000_000);

    await compliance.handleTransactionCompleted(event);
    await compliance.handleTransactionCompleted(event);

    expect(await sars()).toHaveLength(0);
  });
});
