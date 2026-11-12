import * as amqplib from 'amqplib';
import { ConfigService } from '@nestjs/config';
import { ComplianceService } from '../compliance/compliance.service';
import { EventConsumerService } from './event-consumer.service';

jest.mock('amqplib', () => ({ connect: jest.fn() }));

/**
 * Consumidor multi-evento de compliance (RabbitMQ simulado): cada evento llega a su
 * proyección; lo que no tenga manejador se descarta, y lo que falle va a reintento o a la DLQ.
 */
const QUEUE = 'compliance-service.events';
const ANA = '11111111-1111-4111-8111-111111111111';

function fakeBroker() {
  const handlers: {
    connection: Record<string, (...args: any[]) => void>;
    channel: Record<string, (...args: any[]) => void>;
  } = { connection: {}, channel: {} };
  const channel = {
    on: jest.fn((event: string, handler: (...args: any[]) => void) => (handlers.channel[event] = handler)),
    assertExchange: jest.fn().mockResolvedValue(undefined),
    assertQueue: jest.fn().mockResolvedValue(undefined),
    bindQueue: jest.fn().mockResolvedValue(undefined),
    consume: jest.fn().mockResolvedValue(undefined),
    sendToQueue: jest.fn(),
    ack: jest.fn(),
    nack: jest.fn(),
    checkQueue: jest.fn().mockResolvedValue({ messageCount: 0, consumerCount: 1 }),
    get: jest.fn().mockResolvedValue(false),
    close: jest.fn().mockResolvedValue(undefined),
  };
  const connection = {
    on: jest.fn((event: string, handler: (...args: any[]) => void) => (handlers.connection[event] = handler)),
    createChannel: jest.fn().mockResolvedValue(channel),
    close: jest.fn().mockResolvedValue(undefined),
  };
  return { channel, connection, handlers };
}
const delivery = (body: unknown, routingKey = 'transaction.completed') =>
  ({
    content: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
    fields: { routingKey },
    properties: { headers: {}, contentType: 'application/json', messageId: 'm1' },
  }) as unknown as amqplib.ConsumeMessage;

describe('EventConsumerService de compliance', () => {
  const connect = amqplib.connect as unknown as jest.Mock;
  let broker: ReturnType<typeof fakeBroker>;
  let compliance: Record<string, jest.Mock>;

  const build = (env: Record<string, string> = { RABBITMQ_URL: 'amqp://rabbit' }) =>
    new EventConsumerService(new ConfigService(env), compliance as unknown as ComplianceService);
  const started = async (service = build()) => {
    await service.onModuleInit();
    const onMessage = broker.channel.consume.mock.calls[0][1] as (msg: amqplib.ConsumeMessage | null) => Promise<void>;
    return { service, onMessage };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    broker = fakeBroker();
    connect.mockResolvedValue(broker.connection);
    compliance = {
      handleTransactionCompleted: jest.fn().mockResolvedValue(undefined),
      handleAccountCreated: jest.fn().mockResolvedValue(undefined),
      handleIdentityVerified: jest.fn().mockResolvedValue(undefined),
      handleIdentityRejected: jest.fn().mockResolvedValue(undefined),
      handleFraudAlert: jest.fn().mockResolvedValue(undefined),
      handleAccountClosed: jest.fn().mockResolvedValue(undefined),
    };
  });
  afterEach(() => jest.useRealTimers());

  it('sin RABBITMQ_URL no conecta; con ella se suscribe a los seis eventos que proyecta', async () => {
    await build({}).onModuleInit();
    expect(connect).not.toHaveBeenCalled();

    await started();
    expect(broker.channel.bindQueue.mock.calls.map((call) => call[2]).sort()).toEqual([
      'account.closed',
      'account.created',
      'fraud.alert',
      'identity.rejected',
      'identity.verified',
      'transaction.completed',
    ]);
    expect(broker.channel.assertQueue).toHaveBeenCalledWith(`${QUEUE}.dlq`, { durable: true });
  });

  it.each([
    ['transaction.completed', 'handleTransactionCompleted'],
    ['account.created', 'handleAccountCreated'],
    ['identity.verified', 'handleIdentityVerified'],
    ['identity.rejected', 'handleIdentityRejected'],
    ['fraud.alert', 'handleFraudAlert'],
  ])('%s llega a su proyección con los datos del evento y se confirma', async (event, method) => {
    const { onMessage } = await started();
    const msg = delivery({ event, data: { idUser: ANA, x: 1 } });

    await onMessage(msg);

    expect(compliance[method]).toHaveBeenCalledWith({ idUser: ANA, x: 1 });
    expect(broker.channel.ack).toHaveBeenCalledWith(msg);
  });

  it('account.closed llega con la fecha convertida y las cuentas recortadas', async () => {
    const { onMessage } = await started();

    await onMessage(
      delivery({
        event: 'account.closed',
        data: { idUser: ANA, cerradaEn: '2026-11-11T15:00:00.000Z', cuentas: ['4001234567'] },
      }),
    );

    expect(compliance.handleAccountClosed).toHaveBeenCalledWith({
      idUser: ANA,
      closedAt: new Date('2026-11-11T15:00:00.000Z'),
      accounts: ['4001234567'],
    });
  });

  it('un account.closed sin idUser o sin fecha válida va directo a la DLQ (no se reintenta)', async () => {
    const { onMessage } = await started();

    await onMessage(
      delivery({ event: 'account.closed', data: { idUser: 'abc', cerradaEn: '2026-11-11T15:00:00.000Z' } }),
    );
    await onMessage(delivery({ event: 'account.closed', data: { idUser: ANA, cerradaEn: 'ayer' } }));

    expect(broker.channel.sendToQueue.mock.calls.map((call) => call[0])).toEqual([`${QUEUE}.dlq`, `${QUEUE}.dlq`]);
    expect(compliance.handleAccountClosed).not.toHaveBeenCalled();
  });

  it('si el cuerpo no trae el nombre del evento, usa el routing key; uno desconocido se descarta con confirmación', async () => {
    const { onMessage } = await started();

    await onMessage(delivery({ data: { idUser: ANA } }, 'fraud.alert'));
    expect(compliance.handleFraudAlert).toHaveBeenCalledTimes(1);

    const unknown = delivery({ event: 'evento.raro', data: {} }, 'evento.raro');
    await onMessage(unknown);
    expect(broker.channel.ack).toHaveBeenLastCalledWith(unknown);
    expect(broker.channel.sendToQueue).not.toHaveBeenCalled();
  });

  it('JSON inválido va a la DLQ; si la proyección falla, a la cola de espera para reintentar', async () => {
    const { onMessage } = await started();

    await onMessage(delivery('esto no es json'));
    expect(broker.channel.sendToQueue.mock.calls[0][0]).toBe(`${QUEUE}.dlq`);

    compliance.handleFraudAlert.mockRejectedValueOnce(new Error('base caída'));
    await onMessage(delivery({ event: 'fraud.alert', data: { idUser: ANA } }));
    expect(broker.channel.sendToQueue.mock.calls[1][0]).toBe(`${QUEUE}.retry`);

    await onMessage(null);
  });

  it('reconecta a los 5 s si RabbitMQ no está o se cae, y cerrar el módulo cancela el reintento', async () => {
    jest.useFakeTimers();
    connect.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const service = build();
    await service.onModuleInit();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(connect).toHaveBeenCalledTimes(2);

    broker.handlers.connection.close();
    await service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(20_000);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(() => broker.handlers.connection.error(new Error('x'))).not.toThrow();
    expect(() => broker.handlers.channel.error(new Error('x'))).not.toThrow();
  });

  it('panel de la DLQ: sin conexión no deja listar ni reencolar; conectado informa la cola', async () => {
    const offline = build({});
    expect(await offline.deadLetterStats()).toEqual({ connected: false });
    await expect(offline.peekDeadLetters(5)).rejects.toThrow('RabbitMQ no está conectado');
    await expect(offline.requeueDeadLetters(5)).rejects.toThrow('RabbitMQ no está conectado');

    const { service } = await started();
    expect(await service.deadLetterStats()).toMatchObject({ connected: true, queue: QUEUE });
    expect(await service.peekDeadLetters(5)).toEqual([]);
    expect(await service.requeueDeadLetters(5)).toEqual({ moved: 0 });
  });
});
