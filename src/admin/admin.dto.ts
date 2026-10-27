import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class KpisQueryDto {
  @IsDateString() from: string;
  @IsDateString() to: string;
}

export class SarsQueryDto {
  @IsOptional() @IsIn(['open', 'filed', 'dismissed']) status?: string;
  @IsOptional() @IsIn(['low', 'medium', 'high']) severity?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

export class ResolveSarDto {
  @IsIn(['filed', 'dismissed']) status: 'filed' | 'dismissed';
  @IsString() @MinLength(5, { message: 'Escribe el motivo (mínimo 5 caracteres).' }) @MaxLength(300) note: string;
}

export class ReportsQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

export class CreateReportDto {
  @IsDateString() periodFrom: string;
  @IsDateString() periodTo: string;
}

export class AuditQueryDto {
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}

export class ClosuresQueryDto {
  @IsOptional() @IsIn(['por_revisar', 'revisados', 'todos']) estado?: 'por_revisar' | 'revisados' | 'todos';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

export class ReviewClosureDto {
  @IsString() @MinLength(5, { message: 'Escribe el motivo (mínimo 5 caracteres).' }) @MaxLength(300) note: string;
}
