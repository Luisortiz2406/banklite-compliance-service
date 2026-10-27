import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * Proyección propia de `account.closed` (el cliente canceló su cuenta). Una fila
 * por cliente: la clave primaria hace que procesar el evento dos veces no cree
 * otro registro. Si el cliente tuvo alertas de fraude en los 30 días anteriores
 * al cierre (o llegan después), queda marcado para revisión; un empleado de
 * cumplimiento lo marca como revisado desde el panel. No se crea un SAR.
 */
@Entity('compliance_closures')
@Index('idx_compliance_closures_closed', ['closedAt'])
export class ComplianceClosure {
  @PrimaryColumn({ name: 'id_user', type: 'varchar' })
  idUser: string;

  // cerradaEn del evento (cuándo canceló el cliente).
  @Column({ name: 'closed_at', type: 'timestamptz' })
  closedAt: Date;

  // Números de las cuentas que se cerraron.
  @Column({ type: 'jsonb' })
  accounts: string[];

  // Alertas de fraude (SAR de origen fraud.alert) desde 30 días antes del cierre.
  @Column({ name: 'recent_alerts', type: 'int', default: 0 })
  recentAlerts: number;

  @Column({ name: 'requires_review', type: 'boolean', default: false })
  requiresReview: boolean;

  @Column({ name: 'reviewed_by', type: 'varchar', nullable: true })
  reviewedBy: string | null;

  @Column({ name: 'reviewed_at', type: 'timestamptz', nullable: true })
  reviewedAt: Date | null;

  @Column({ name: 'review_note', type: 'varchar', length: 300, nullable: true })
  reviewNote: string | null;

  @CreateDateColumn({ name: 'processed_at', type: 'timestamptz' })
  processedAt: Date;
}
