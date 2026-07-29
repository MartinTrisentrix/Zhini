import { Hono } from 'hono';
import { getNearbyService,getNearbyHomeServices,createServiceProvider,getAllServiceProviders } from '../controllers/serviceController.js';

const serviceRouter = new Hono();


serviceRouter.get('/locator', getNearbyService);
serviceRouter.get('/home-services', getNearbyHomeServices);
serviceRouter.post('/create-provider', createServiceProvider);
serviceRouter.get('/all-service', getAllServiceProviders);


export default serviceRouter;