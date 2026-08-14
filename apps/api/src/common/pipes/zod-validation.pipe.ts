import { PipeTransform, Injectable, ArgumentMetadata } from '@nestjs/common';
import { ZodSchema, ZodError } from 'zod';
import { validationFailed } from '../errors/app-error.js';

/**
 * Validates and coerces a request payload against a Zod schema.
 *
 * The parsed result replaces the raw input, so unknown keys are stripped:
 * a client cannot smuggle organisationId, role, or a precomputed total into a
 * create/update call (Security Doc §16, §34).
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown, _metadata: ArgumentMetadata): T {
    try {
      return this.schema.parse(value);
    } catch (error) {
      if (error instanceof ZodError) {
        throw validationFailed(
          error.issues.map((issue) => ({
            field: issue.path.join('.') || '(root)',
            message: issue.message,
          })),
        );
      }
      throw error;
    }
  }
}

export const zodPipe = <T>(schema: ZodSchema<T>) => new ZodValidationPipe(schema);
