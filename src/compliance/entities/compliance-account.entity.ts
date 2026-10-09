import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** Proyección propia de `account.created` (alta de cliente en auth-service). Usada para el KPI de clientes nuevos. */
@Entity('compliance_accounts')
export class ComplianceAccount {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'id_user', type: 'varchar', unique: true })
  idUser: string;

  @Column({ type: 'varchar', nullable: true })
  email: string | null;

  @Column({ name: 'nombre_completo', type: 'varchar', nullable: true })
  nombreCompleto: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
