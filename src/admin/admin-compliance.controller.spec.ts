import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { AdminAuditService } from '../common/staff/admin-audit.service';
import { StaffAuthGuard, StaffRole } from '../common/staff/staff-auth.guard';
import { ComplianceService } from '../compliance/compliance.service';
import { EventConsumerService } from '../events/event-consumer.service';
import { AdminComplianceController } from './admin-compliance.controller';
import request = require('supertest');

const SECRET = 'secreto-de-prueba-para-tokens-de-empleado-0123456789';
const SAR_ID = '33333333-3333-4333-8333-333333333333';
const CLIENTE = '11111111-1111-4111-8111-111111111111';

describe('Permisos del panel de cumplimiento (403 por rol)', () => {
  let app: INestApplication;
  const jwt = new JwtService({});
  const sar = { id: SAR_ID, idUser: 'u1', accountId: 'a1', severity: 'high', status: 'filed' };
  const compliance = {
    listSars: jest.fn().mockResolvedValue({ items: [] }),
    sars: jest.fn().mockResolvedValue({ items: [] }),
    resolveSar: jest.fn().mockResolvedValue({ sar }),
    listClosures: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, limit: 25 }),
    closureDetail: jest.fn().mockResolvedValue({ idUser: CLIENTE, alerts: [] }),
    markClosureReviewed: jest.fn().mockResolvedValue({ closure: { idUser: CLIENTE } }),
  };
  const audit = { record: jest.fn(), list: jest.fn().mockResolvedValue({ items: [] }) };

  const token = (role: StaffRole) =>
    `Bearer ${jwt.sign({ sub: `staff-${role}`, type: 'staff', role, username: role }, { secret: SECRET })}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminComplianceController],
      providers: [
        StaffAuthGuard,
        { provide: JwtService, useValue: jwt },
        {
          provide: ConfigService,
          useValue: { get: (key: string) => (key === 'STAFF_JWT_SECRET' ? SECRET : undefined) },
        },
        { provide: ComplianceService, useValue: compliance },
        { provide: AdminAuditService, useValue: audit },
        { provide: EventConsumerService, useValue: { deadLetterStats: jest.fn().mockResolvedValue({}) } },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  const resolveBody = { status: 'filed', note: 'Se reporta a la UIAF por montos fraccionados' };

  it('Soporte NO puede resolver un SAR (403)', async () => {
    await request(app.getHttpServer())
      .patch(`/compliance/admin/sars/${SAR_ID}`)
      .set('Authorization', token('support'))
      .send(resolveBody)
      .expect(403);
    expect(compliance.resolveSar).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('Soporte NO ve los reportes de actividad sospechosa ni los KPIs (403)', async () => {
    await request(app.getHttpServer()).get('/compliance/admin/sars').set('Authorization', token('support')).expect(403);
    await request(app.getHttpServer())
      .get('/compliance/admin/kpis?from=2026-01-01&to=2026-01-31')
      .set('Authorization', token('support'))
      .expect(403);
  });

  it.each<StaffRole>(['compliance', 'admin'])('%s resuelve un SAR y queda en la auditoría con su rol', async (role) => {
    await request(app.getHttpServer())
      .patch(`/compliance/admin/sars/${SAR_ID}`)
      .set('Authorization', token(role))
      .send(resolveBody)
      .expect(200);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ role, username: role }),
      expect.objectContaining({ action: 'sar.filed', targetId: SAR_ID, reason: resolveBody.note }),
    );
  });

  it('Soporte sí ve el estado de la cola (Monitoreo)', async () => {
    await request(app.getHttpServer()).get('/compliance/admin/dlq').set('Authorization', token('support')).expect(200);
  });

  describe('Cierres de cuenta', () => {
    const reviewBody = { note: 'Revisado con el equipo de fraude' };

    it('Soporte NO ve los cierres ni puede marcarlos revisados (403)', async () => {
      const server = app.getHttpServer();
      await request(server).get('/compliance/admin/closures').set('Authorization', token('support')).expect(403);
      await request(server)
        .get(`/compliance/admin/closures/${CLIENTE}`)
        .set('Authorization', token('support'))
        .expect(403);
      await request(server)
        .patch(`/compliance/admin/closures/${CLIENTE}`)
        .set('Authorization', token('support'))
        .send(reviewBody)
        .expect(403);
      expect(compliance.listClosures).not.toHaveBeenCalled();
      expect(compliance.markClosureReviewed).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it.each<StaffRole>(['compliance', 'admin'])('%s consulta el listado y queda en la bitácora', async (role) => {
      await request(app.getHttpServer())
        .get('/compliance/admin/closures?estado=por_revisar')
        .set('Authorization', token(role))
        .expect(200);
      expect(compliance.listClosures).toHaveBeenCalledWith('por_revisar', 1, 25);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ role, username: role }),
        expect.objectContaining({
          action: 'closure.list_viewed',
          details: expect.objectContaining({ estado: 'por_revisar' }),
        }),
      );
    });

    it('el detalle de un cierre queda en la bitácora con el cliente', async () => {
      await request(app.getHttpServer())
        .get(`/compliance/admin/closures/${CLIENTE}`)
        .set('Authorization', token('compliance'))
        .expect(200);
      expect(audit.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'closure.viewed', targetId: CLIENTE }),
      );
    });

    it('un cierre que no existe responde 404 y no se registra', async () => {
      compliance.closureDetail.mockResolvedValueOnce(null);
      await request(app.getHttpServer())
        .get(`/compliance/admin/closures/${CLIENTE}`)
        .set('Authorization', token('compliance'))
        .expect(404);
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('Marcar revisado: pasa el motivo y el empleado; un conflicto responde 409', async () => {
      await request(app.getHttpServer())
        .patch(`/compliance/admin/closures/${CLIENTE}`)
        .set('Authorization', token('compliance'))
        .send(reviewBody)
        .expect(200);
      expect(compliance.markClosureReviewed).toHaveBeenCalledWith(
        CLIENTE,
        reviewBody.note,
        expect.objectContaining({ username: 'compliance', role: 'compliance' }),
      );

      compliance.markClosureReviewed.mockResolvedValueOnce({ conflict: 'Este cierre ya fue revisado por x.' });
      await request(app.getHttpServer())
        .patch(`/compliance/admin/closures/${CLIENTE}`)
        .set('Authorization', token('compliance'))
        .send(reviewBody)
        .expect(409);
    });

    it('rechaza un motivo corto, un filtro desconocido y un id que no es UUID (400)', async () => {
      const server = app.getHttpServer();
      await request(server)
        .patch(`/compliance/admin/closures/${CLIENTE}`)
        .set('Authorization', token('compliance'))
        .send({ note: 'ok' })
        .expect(400);
      await request(server)
        .get('/compliance/admin/closures?estado=otro')
        .set('Authorization', token('compliance'))
        .expect(400);
      await request(server)
        .get('/compliance/admin/closures/no-es-uuid')
        .set('Authorization', token('compliance'))
        .expect(400);
      expect(compliance.markClosureReviewed).not.toHaveBeenCalled();
    });
  });
});
