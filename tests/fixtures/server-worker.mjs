import {createMirevaServer} from '../../server/index.mjs';
const app=await createMirevaServer({dataDir:process.env.TEST_DATA,port:0,passwordN:16384,compactEvery:5});
process.send({port:app.port});process.on('message',async m=>{if(m==='close'){await app.close();process.exit(0);}});
