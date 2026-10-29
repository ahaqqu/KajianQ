/** A plain `.js` helper — never type-checked by the package's tsconfig — that reaches infra. */
import { createLogger } from "@app/infra";

export const helper = createLogger;
