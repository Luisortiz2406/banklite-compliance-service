import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Proyección propia de `transaction.completed` (sección 4.10 del documento:
 * ningún servicio lee directamente la base de otro). Es la base de los KPIs
 * de volumen/cantidad y de la regla de AML por volumen acumulado.
 */
@Entity('compliance_transactions')
@Index('idx_compliance_tx_unique', ['transactionId', 'accountId'], { unique: true })
@Index('idx_compliance_tx_account_time', ['accountId', 'occurredAt'])
@Index('idx_compliance_tx_time', ['occurredAt'])
export class ComplianceTransaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'transaction_id', type: 'uuid' })
  transactionId: string;

  @Column({ name: 'account_id', type: 'uuid' })
  accountId: string;

  @Column({ name: 'id_user', type: 'varchar' })
  idUser: string;

  @Column({ type: 'varchar' })
  type: string;

  @Column({ type: 'varchar' })
  direction: 'in' | 'out';

  @Column({ type: 'numeric', precision: 18, scale: 2 })
  amount: string;

  @Column({ type: 'varchar', length: 3 })
  currency: string;

  @Column({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
