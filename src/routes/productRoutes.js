import { Hono } from 'hono';
import { createProductSubmission,getSubmissionByMobile,AIassist,addMember } from '../controllers/productController.js';

const productRouter = new Hono();

// POST endpoint mapping
productRouter.post('/submit', createProductSubmission);
productRouter.post('/member', addMember);
productRouter.get('/search', getSubmissionByMobile);
productRouter.post('/ai', AIassist);

export default productRouter;