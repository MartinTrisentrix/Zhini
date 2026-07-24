import { Hono } from 'hono';
import { uploadMedia } from '../controllers/mediaController.js';

const mediaRouter = new Hono();

// POST /api/media/upload
mediaRouter.post('/upload', uploadMedia);

export default mediaRouter;