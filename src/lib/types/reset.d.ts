// ts-reset: tightens built-in types across the whole project.
// - JSON.parse and response.json() return `unknown` (forces validation)
// - Array.isArray narrows to readonly arrays correctly
// - .filter(Boolean) removes nullish/falsy from the element type
// One import; affects every .ts file via tsconfig include.
import "@total-typescript/ts-reset";
