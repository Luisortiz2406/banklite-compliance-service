import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ComplianceService } from '../compliance/compliance.service';
import { AdminAuditService } from '../common/staff/admin-audit.service';
import { StaffAuthGuard, StaffRoles } from '../common/staff/staff-auth.guard';
import { EventConsumerService } from '../events/event-consumer.service';
import {
  AuditQueryDto,
  CreateReportDto,
  KpisQueryDto,
  ReportsQueryDto,
  ResolveSarDto,
  SarsQueryDto,
} from './admin.dto';

/** Panel administrativo de Compliance Service: KPIs, SAR y reportes AML. */
@Controller('compliance/admin')
@UseGuards(StaffAuthGuard)
export class AdminComplianceController {
  constructor(
    private readonly compliance: ComplianceService,
    private readonly audit: AdminAuditService,
    private readonly consumer: EventConsumerService,
  ) {}

  @Get('kpis')
  kpis(@Query() q: KpisQueryDto) {
    const from = new Date(q.from);
    const to = new Date(q.to);
    if (from > to) throw new BadRequestException("'from' debe ser anterior a 'to'.");
    return this.compliance.kpis(from, to);
  }

  @Get('sars')
  sars(@Query() q: SarsQueryDto) {
    return this.compliance.listSars(q.status, q.severity, q.page ?? 1, q.limit ?? 25);
  }

  @Get('sars/:id')
  async sarDetail(@Param('id') id: string) {
    const sar = await this.compliance.sarDetail(id);
    if (!sar) throw new NotFoundException('SAR no encontrado.');
    return sar;
  }

  @Patch('sars/:id')
  @StaffRoles('admin')
  async resolveSar(@Param('id') id: string, @Body() dto: ResolveSarDto, @Req() req: any) {
    const result = await this.compliance.resolveSar(id, dto.status, dto.note, req.staff.username);
    if (!result) throw new NotFoundException('SAR no encontrado.');
    if (result.conflict)
      throw new ConflictException(`Este SAR ya fue resuelto (estado actual: '${result.sar.status}').`);
    await this.audit.record(req.staff, {
      action: `sar.${dto.status}`,
      targetType: 'suspicious_activity_report',
      targetId: id,
      reason: dto.note,
      details: { idUser: result.sar.idUser, accountId: result.sar.accountId, severity: result.sar.severity },
    });
    return result.sar;
  }

  @Get('reports')
  reports(@Query() q: ReportsQueryDto) {
    return this.compliance.listReports(q.page ?? 1, q.limit ?? 25);
  }

  @Get('reports/:id')
  async reportDetail(@Param('id') id: string) {
    const report = await this.compliance.reportDetail(id);
    if (!report) throw new NotFoundException('Reporte no encontrado.');
    return report;
  }

  @Post('reports')
  @HttpCode(201)
  @StaffRoles('admin')
  async createReport(@Body() dto: CreateReportDto, @Req() req: any) {
    if (dto.periodFrom > dto.periodTo) throw new BadRequestException("'periodFrom' debe ser anterior a 'periodTo'.");
    const report = await this.compliance.generateReport(dto.periodFrom, dto.periodTo, req.staff.username);
    await this.audit.record(req.staff, {
      action: 'report.generate',
      targetType: 'aml_report',
      targetId: report.id,
      details: { periodFrom: dto.periodFrom, periodTo: dto.periodTo },
    });
    return report;
  }

  @Get('audit')
  auditLog(@Query() q: AuditQueryDto) {
    return this.audit.list(q.page ?? 1, q.limit ?? 50, q.q);
  }

  @Get('dlq')
  dlq() {
    return this.consumer.deadLetterStats();
  }

  @Get('dlq/messages')
  async dlqMessages() {
    try {
      return await this.consumer.peekDeadLetters(20);
    } catch (e) {
      throw new ServiceUnavailableException((e as Error).message);
    }
  }

  @Post('dlq/requeue')
  @HttpCode(200)
  @StaffRoles('admin')
  async requeue(@Req() req: any) {
    try {
      const result = await this.consumer.requeueDeadLetters(100);
      await this.audit.record(req.staff, {
        action: 'dlq.requeue',
        targetType: 'queue',
        targetId: 'compliance-service',
        details: result,
      });
      return result;
    } catch (e) {
      throw new ServiceUnavailableException((e as Error).message);
    }
  }
}
