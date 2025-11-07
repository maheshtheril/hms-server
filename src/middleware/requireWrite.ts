// server/src/middleware/requireWrite.ts
import { Request, Response, NextFunction } from 'express';

const requireWrite = (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as any).user;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const permissions: string[] = Array.isArray(user.permissions) ? user.permissions : [];
    const roles: string[] = Array.isArray(user.roles) ? user.roles : [];

    if (permissions.includes('write') || roles.includes('admin')) {
      return next();
    }

    return res.status(403).json({ error: 'Forbidden: write access required' });
  } catch (err) {
    return next(err);
  }
};

export default requireWrite;
