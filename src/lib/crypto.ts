import bcrypt from "bcryptjs";

/** Hash a plain text string (e.g., password) */
export const hash = (s: string) => bcrypt.hashSync(s, 10);

/** Compare a plain text string against a hashed value */
export const compare = (s: string, h: string) => bcrypt.compareSync(s, h);
