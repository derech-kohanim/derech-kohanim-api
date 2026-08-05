import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

import type { DeletionRequestSource } from '@shared';

const SOURCES: DeletionRequestSource[] = ['web', 'android'];

export class CreateDeletionRequestDto {
  @ApiProperty({
    description:
      'Address of the account to delete. Ignored for a signed-in caller, whose own address ' +
      'is used instead - only a proven address may target an account.',
    example: 'user@example.com',
  })
  @IsEmail()
  @MaxLength(320)
  email: string;

  @ApiPropertyOptional({ description: 'Why the account is being deleted', maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;

  @ApiPropertyOptional({ enum: SOURCES, default: 'web' })
  @IsOptional()
  @IsIn(SOURCES)
  source?: DeletionRequestSource;
}
