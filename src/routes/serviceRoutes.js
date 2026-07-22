import { Hono } from 'hono';
import { getNearbyService } from '../controllers/serviceController.js';

const serviceRouter = new Hono();


serviceRouter.get('/locator', getNearbyService);

export default serviceRouter;