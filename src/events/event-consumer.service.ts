import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqplib from 'amqplib';
import { ComplianceService } from '../compliance/compliance.service';
import {
  assertRetryQueues,
  handleFailure,
  peekDeadLetters,
  queueStats,
  requeueDeadLetters,
  originalRoutingKey,
  PoisonMessageError,
} from './retry-policy';

const RECONNECT_DELAY_MS = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Valida el contenido de account.closed; si no sirve, el mensaje va directo a la DLQ. */
export function parseAccountClosed(data: any) {
  if (typeof data?.idUser !== 'string' || !UUID.test(data.idUser))
    throw new PoisonMessageError('account.closed sin idUser válido.');
  if (typeof data.cerradaEn !== 'string' || isNaN(Date.parse(data.cerradaEn)))
    throw new PoisonMessageError('account.closed sin fecha de cierre válida.');
  const accounts = Array.isArray(data.cuentas)
    ? data.cuentas.filter((c: unknown): c is string => typeof c === 'string').map((c: string) => c.slice(0, 40))
    : [];
  return { idUser: data.idUser as string, closedAt: new Date(data.cerradaEn), accounts };
}

// Eventos que Compliance proyecta en sus propias tablas (sección 4.10 del
// documento: nunca lee la base de otro servicio). `fraud.alert` lo publica
// Fraud Service y `account.closed`, account-service (cancelación de la cuenta).
const SUBSCRIBED_EVENTS = [
  'transaction.completed',
  'account.created',
  'identity.verified',
  'identity.rejected',
  'fraud.alert',
  'account.closed',
];

/**
 * Consumidor multi-evento: a diferencia de los demás servicios (que se
 * suscriben a un único evento), Compliance necesita varias proyecciones para
 * sus KPIs y sus SAR, así que una sola cola se enlaza a varios routing keys
 * (mismo patrón que notification-service).
 *
 * Si RabbitMQ no está disponible al iniciar, o se cae después, reintenta en
 * segundo plano sin bloquear el arranque del servicio ni sus endpoints REST.
 * Si un evento falla al procesarse, se reintenta varias veces con espera y,
 * si sigue fallando, queda en la DLQ (<cola>.dlq) en lugar de perderse.
 */
@Injectable()
export class EventConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('EventConsumer[compliance-service]');
  private connection: amqplib.ChannelModel | null = null;
  private channel: amqplib.Channel | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private destroyed = false;
  private queue: string | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly compliance: ComplianceService,
  ) {}

  async onModuleInit() {
    await this.connect();
  }

  private async connect() {
    if (this.destroyed) return;
    const url = this.config.get<string>('RABBITMQ_URL');
    if (!url) {
      this.logger.warn('RABBITMQ_URL no configurada. No se consumirán eventos.');
      return;
    }
    try {
      const connection = await amqplib.connect(url);
      this.connection = connection;
      // Sin listener de 'error', un fallo de la conexión tumbaría el proceso.
      connection.on('error', (err) => this.logger.warn(`Error en la conexión con RabbitMQ: ${err.message}`));
      connection.on('close', () => {
        this.connection = null;
        this.channel = null;
        this.logger.warn('Conexión con RabbitMQ cerrada.');
        this.scheduleReconnect();
      });
      const channel = await connection.createChannel();
      channel.on('error', (err) => this.logger.warn(`Error en el canal de RabbitMQ: ${err.message}`));
      channel.on('close', () => {
        this.channel = null;
        if (!this.destroyed) connection.close().catch(() => undefined);
      });
      this.channel = channel;

      const exchange = this.config.get<string>('RABBITMQ_EXCHANGE', 'banklite.events');
      const queue = this.config.get<string>('RABBITMQ_QUEUE', 'compliance-service.events');

      await channel.assertExchange(exchange, 'topic', { durable: true });
      await channel.assertQueue(queue, { durable: true });
      for (const routingKey of SUBSCRIBED_EVENTS) await channel.bindQueue(queue, exchange, routingKey);
      await assertRetryQueues(channel, queue);
      this.queue = queue;

      await channel.consume(queue, (msg) => this.handleMessage(channel, queue, msg), { noAck: false });

      this.logger.log(`Escuchando ${SUBSCRIBED_EVENTS.join(', ')} en cola '${queue}'.`);
    } catch (err) {
      this.logger.warn(
        `No se pudo conectar a RabbitMQ (${(err as Error).message}). Reintentando en ${RECONNECT_DELAY_MS / 1000}s.`,
      );
      await this.connection?.close().catch(() => undefined);
      this.connection = null;
      this.channel = null;
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.destroyed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, RECONNECT_DELAY_MS);
  }

  // Se usa el canal por el que llegó el mensaje: el ack debe ir por ese mismo canal.
  private async handleMessage(channel: amqplib.Channel, queue: string, msg: amqplib.ConsumeMessage | null) {
    if (!msg) return;
    try {
      let content: any;
      try {
        content = JSON.parse(msg.content.toString());
      } catch {
        throw new PoisonMessageError('El mensaje no es JSON válido.');
      }
      const event: string | undefined = content?.event ?? originalRoutingKey(msg);
      const data = content?.data ?? {};

      switch (event) {
        case 'transaction.completed':
          await this.compliance.handleTransactionCompleted(data);
          break;
        case 'account.created':
          await this.compliance.handleAccountCreated(data);
          break;
        case 'identity.verified':
          await this.compliance.handleIdentityVerified(data);
          break;
        case 'identity.rejected':
          await this.compliance.handleIdentityRejected(data);
          break;
        case 'fraud.alert':
          await this.compliance.handleFraudAlert(data);
          break;
        case 'account.closed':
          await this.compliance.handleAccountClosed(parseAccountClosed(data));
          break;
        default:
          this.logger.warn(`Evento '${event}' sin manejador en Compliance, descartado.`);
      }

      this.logger.log(`Evento '${event}' procesado.`);
      channel.ack(msg);
    } catch (err) {
      handleFailure(channel, queue, msg, err as Error, this.logger);
    }
  }

  /** Panel administrativo: estado de la cola, sus reintentos y su DLQ. */
  async deadLetterStats() {
    if (!this.channel || !this.queue) return { connected: false };
    return { connected: true, ...(await queueStats(this.channel, this.queue)) };
  }

  async peekDeadLetters(max: number) {
    if (!this.channel || !this.queue) throw new Error('RabbitMQ no está conectado.');
    return peekDeadLetters(this.channel, this.queue, max);
  }

  async requeueDeadLetters(max: number) {
    if (!this.channel || !this.queue) throw new Error('RabbitMQ no está conectado.');
    return requeueDeadLetters(this.channel, this.queue, max);
  }

  async onModuleDestroy() {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
  }
}
