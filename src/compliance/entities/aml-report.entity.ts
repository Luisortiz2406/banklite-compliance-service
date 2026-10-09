import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Reporte regulatorio periódico (nombre literal de la sección 4 del
 * documento: `aml_reports`). Es un snapshot de KPIs para un periodo; una vez
 * generado no se reescribe (solo inserción, coherente con la filosofía
 * ledger-first del documento aplicada aquí a los reportes de cumplimiento).
 */
@Entity('aml_reports')
export class AmlReport {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'period_from', type: 'date' })
  periodFrom: string;

  @Column({ name: 'period_to', type: 'date' })
  periodTo: string;

  @Column({ name: 'generated_by', type: 'varchar' })
  generatedBy: string;

  @Column({ name: 'total_transactions', type: 'int' })
  totalTransactions: number;

  @Column({ name: 'total_volume', type: 'numeric', precision: 18, scale: 2 })
  totalVolume: string;

  @Column({ name: 'flagged_count', type: 'int' })
  flaggedCount: number;

  @Column({ name: 'sar_count', type: 'int' })
  sarCount: number;

  @Column({ name: 'new_accounts', type: 'int' })
  newAccounts: number;

  @Column({ name: 'kyc_approval_rate', type: 'numeric', precision: 5, scale: 2, nullable: true })
  kycApprovalRate: string | null;

  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  @CreateDateColumn({ name: 'generated_at', type: 'timestamptz' })
  generatedAt: Date;
}
