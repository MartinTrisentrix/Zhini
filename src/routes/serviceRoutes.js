import { Hono } from 'hono';
import { getNearbyService,getNearbyHomeServices } from '../controllers/serviceController.js';

const serviceRouter = new Hono();


serviceRouter.get('/locator', getNearbyService);
serviceRouter.get('/home-services', getNearbyHomeServices);

export default serviceRouter;