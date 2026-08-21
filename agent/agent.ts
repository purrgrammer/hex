import { defineAgent } from "eve";

import { chooseModel } from "./lib/model.js";

/**
 * The agent, minus the one decision that is a deployment's to make.
 *
 * Which model this runs on lives in the environment rather than here — see
 * `lib/model.ts` for the variables and what each provider needs. Eve's setup
 * flow only offers ChatGPT and the AI Gateway, but `defineAgent`'s `model`
 * takes a provider instance as well as a gateway id, so every model either
 * route reaches is reachable from configuration.
 */
export default defineAgent(chooseModel());
