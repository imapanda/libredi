export { type Difference, diffJson } from "./diff.ts";
export {
  MappingError,
  type MappingErrorCode,
  type MappingErrorData,
} from "./errors.ts";
export {
  type CompiledMapping,
  compileMapping,
  DEFAULT_LIMITS,
  type FieldNode,
  type Limits,
  type Mapping,
  UNAVAILABLE_FUNCTIONS,
} from "./evaluate.ts";
