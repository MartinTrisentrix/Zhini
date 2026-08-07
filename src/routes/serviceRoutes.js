import { Hono } from 'hono';
import { getNearbyService,getNearbyHomeServices,createServiceProvider,createServiceTicket,getProviderTickets,updateTicketStatus,getServiceProviderByMobile } from '../controllers/serviceController.js';

const serviceRouter = new Hono();


serviceRouter.post('/service', getNearbyService);

serviceRouter.get('/home-services', getNearbyHomeServices);
serviceRouter.post('/create-provider', createServiceProvider);

serviceRouter.get('/provider', getServiceProviderByMobile);

serviceRouter.post('/create-ticket', createServiceTicket);

serviceRouter.post('/provider-tickets', getProviderTickets);

serviceRouter.put('/update-status', updateTicketStatus);



export default serviceRouter;