import { Hono } from 'hono';
import { createProductSubmission,getSubmissionByMobile,AIassist,addMember,updateEntity,deleteMember,deleteRoomProduct } from '../controllers/productController.js';

const productRouter = new Hono();

// POST endpoint mapping
productRouter.post('/submit', createProductSubmission);
productRouter.put('/update', updateEntity);

productRouter.post('/member', addMember);

productRouter.delete('/delete-member/:homeId', deleteMember);
productRouter.delete('/delete-product/:homeId', deleteRoomProduct);


productRouter.get('/search', getSubmissionByMobile);

productRouter.post('/ai', AIassist);

export default productRouter;