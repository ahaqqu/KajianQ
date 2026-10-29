/** Reaches no workspace package and no database client: the walk must stay green here. */
import { join } from "node:path";

export const helper = join("a", "b");
