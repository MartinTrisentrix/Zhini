import { Hono } from 'hono';
import { getNearbyService,getNearbyHomeServices,createServiceProvider,getServiceProviderByMobile } from '../controllers/serviceController.js';

const serviceRouter = new Hono();


serviceRouter.get('/locator', getNearbyService);
serviceRouter.get('/home-services', getNearbyHomeServices);
serviceRouter.post('/create-provider', createServiceProvider);
serviceRouter.get('/provider', getServiceProviderByMobile);



export default serviceRouter;