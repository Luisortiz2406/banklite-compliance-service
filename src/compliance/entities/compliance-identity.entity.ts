import { Column, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/** Proyección propia de `identity.verified` / `identity.rejected` (KYC). Usada para el KPI de tasa de aprobación. */
@Entity('compliance_identities')
export class ComplianceIdentity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'id_user', type: 'varchar', unique: true })
  idUser: string;

  @Column({ type: 'boolean', default: false })
  verified: boolean;

  @Column({ name: 'rejected_count', type: 'int', default: 0 })
  rejectedCount: number;

  @UpdateDateColumn({ name: 'last_event_at', type: 'timestamptz' })
  lastEventAt: Date;
}
