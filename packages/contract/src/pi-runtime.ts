/**
 * The one name main and the agent host must agree on about managed Pi.
 *
 * It lives in the contract for the same reason command names do: it is
 * vocabulary shared across a process boundary, and the two ends are forbidden
 * to import each other. Main chooses the directory and the host acts on it, and
 * neither can see the other's source — an import-boundary test says so — so a
 * string spelled twice would be a string that could be spelled differently
 * twice, with a silent fall back to the bundled Pi as the only symptom.
 */
export const PI_ROOT_ENV = "BAKE_PI_PI_ROOT"
