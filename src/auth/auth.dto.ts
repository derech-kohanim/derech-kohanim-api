import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class RegisterDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ minLength: 8, example: 'correct-horse-battery' })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password: string;

  @ApiPropertyOptional({ example: 'ישראל ישראלי' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  displayName?: string;

  @ApiProperty({
    description: 'Must equal the current terms version, otherwise registration is rejected',
    example: '2026-07-01',
  })
  @IsString()
  @IsNotEmpty()
  acceptedTermsVersion: string;
}

export class LoginDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  email: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  password: string;
}

export class GoogleAuthDto {
  @ApiProperty({ description: 'Google Identity Services credential (JWT)' })
  @IsString()
  @IsNotEmpty()
  idToken: string;

  @ApiPropertyOptional({ description: 'Required when the account does not exist yet' })
  @IsOptional()
  @IsString()
  acceptedTermsVersion?: string;
}

export class DevLoginDto {
  @ApiPropertyOptional({ description: 'Defaults to AUTH_DEV_LOGIN_EMAIL' })
  @IsOptional()
  @IsEmail()
  email?: string;
}

export class RefreshDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}

export class AcceptTermsDto {
  @ApiProperty({ example: '2026-07-01' })
  @IsString()
  @IsNotEmpty()
  version: string;
}
