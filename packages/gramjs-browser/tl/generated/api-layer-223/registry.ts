import { declarations } from './constructors.ts';
export const registry = Object.freeze(Object.fromEntries(declarations.map((d) => [d.name, d])));
