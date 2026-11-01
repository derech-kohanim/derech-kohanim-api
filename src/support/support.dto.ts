import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from "class-validator";

import { LatLngDto } from "../common/dto";
import type { SupportKind, SupportPlatform } from "@shared";

// Mirrors SUPPORT_KINDS in the shared contract (only `import type` survives the build).
const KINDS: SupportKind[] = ["bug", "route", "data", "suggestion"];
const PLATFORMS: SupportPlatform[] = ["web", "android"];

export class SupportReportDto {
  @ApiProperty({ enum: KINDS })
  @IsIn(KINDS)
  kind: SupportKind;

  @ApiProperty({ maxLength: 4000 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  message: string;

  @ApiProperty({ enum: PLATFORMS })
  @IsIn(PLATFORMS)
  platform: SupportPlatform;

  @ApiProperty({ example: "0.1.0" })
  @IsString()
  @MaxLength(40)
  appVersion: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  device?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  routeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  zoneId?: number;

  @ApiPropertyOptional({ type: LatLngDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => LatLngDto)
  location?: LatLngDto;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  replyByEmail?: boolean;
}
