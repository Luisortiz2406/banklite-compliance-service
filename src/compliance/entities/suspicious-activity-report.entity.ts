import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type SarStatus = 'open' | 'filed' | 'dismissed';
export type SarSeverity = 'low' | 'medium' | 'high';
export type SarSource = 'fraud.alert' | 'volume_rule';

/**
 * Reporte de Actividad Sospechosa (SAR, nombre literal de la sección 4 del
 * documento: `suspicious_activity_reports`). Se crea automáticamente al
 * consumir `fraud.alert` de Fraud Service, o por la propia regla de AML de
 * este servicio (volumen de salida acumulado). Soporte/cumplimiento lo
 * cierra desde el panel (filed = se radicó ante la autoridad, dismissed =
 * se descartó tras revisar).
 */
@Entity('suspicious_activity_reports')
@Index('idx_sar_status_time', ['status', 'createdAt'])
export class SuspiciousActivityReport {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'id_user', type: 'varchar' })
  idUser: string;

  @Index()
  @Column({ name: 'account_id', type: 'uuid', nullable: true })
  accountId: string | null;

  @Column({ name: 'transaction_id', type: 'uuid', nullable: true })
  transactionId: string | null;

  @Column({ type: 'varchar', length: 500 })
  reason: string;

  @Column({ type: 'varchar' })
  severity: SarSeverity;

  @Column({ type: 'varchar' })
  source: SarSource;

  @Column({ type: 'varchar', default: 'open' })
  status: SarStatus;

  @Column({ name: 'filed_by', type: 'varchar', nullable: true })
  filedBy: string | null;

  @Column({ name: 'filed_at', type: 'timestamptz', nullable: true })
  filedAt: Date | null;

  @Column({ name: 'resolution_note', type: 'varchar', length: 300, nullable: true })
  resolutionNote: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
