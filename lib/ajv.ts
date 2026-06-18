import ajvModule from 'ajv';
import addFormatsModule from 'ajv-formats';

interface CompiledValidator {
  (data: unknown): boolean;
  errors?: Array<{ instancePath?: string; message?: string }> | null;
}

type AjvConstructor = new (options?: object) => {
  compile: (schema: object) => CompiledValidator;
};

type AddFormatsFn = (ajv: InstanceType<AjvConstructor>) => void;

const Ajv = ajvModule as unknown as AjvConstructor;
const addFormats = addFormatsModule as unknown as AddFormatsFn;

export function createValidator(schema: object): CompiledValidator {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(schema);
}

export function formatValidationErrors(
  errors: Array<{ instancePath?: string; message?: string }> | null | undefined,
): string[] {
  return (errors ?? []).map((err) => `${err.instancePath || '/'}: ${err.message}`);
}
