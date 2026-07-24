import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import 'dotenv/config';

const app = new Hono();

import { initMinioBucket } from './src/services/minioClient.js';

import productRouter from './src/routes/productRoutes.js';
import serviceRouter from './src/routes/serviceRoutes.js';
import mediaRouter from './src/routes/mediaRoutes.js';


app.use('*', cors());

app.route('/product', productRouter);
app.route('/media', mediaRouter);
app.route('/service', serviceRouter);




const port = 3003;

initMinioBucket();
// Serve the Hono application
serve({
  fetch: app.fetch,
  port,
  hostname: '0.0.0.0'
}, (info) => {
  console.log(`🚀 ZHINI Backend Live: http://localhost:${info.port}`);
});