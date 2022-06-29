const websocket = require('ws');
const fs = require('fs');
const axios= require('axios');
var jwt = require('jsonwebtoken');

const auth=  "https://asr-lvl.voxist.com/oauth/token"
let socket_url =   'https://asr-lvl.voxist.com/websocket'
const filename =  process.argv[4] || "../karimduval.wav"

axios.post(auth, {grant_type: "password", username: process.argv[2], password: process.argv[3]})
  .then(async (res) => {
    let ws_resp = await axios.get(socket_url, {headers: {authorization: "Bearer " + res.data.access_token}})
    console.log(ws_resp.data)
    const ws = new websocket(ws_resp.data.url);
    let start = Date.now()
    let first = true;
    ws.on('open', () => {
      var readStream = fs.createReadStream(filename, { highWaterMark: 3200 });
      start = Date.now()
      ws.send('{"config": {"sample_rate": 16000, "lang" : "fr"}}');
      readStream.on('data',  (chunk) => {
        ws.send(chunk);
      });
      readStream.on('end', async () => {
        //console.log("Elapsed : " + (Date.now() - start) + " ms", "File sent")
        ws.send('{"eof" : 1}');
      });
      
    });
    ws.on('message', (data) => {
      let message  = JSON.parse(data);
      if(message["Text"] !== ""){
        if(first == true) {
          first = false;
          console.log("First word : " + (Date.now() - start) + " ms")
        }
        console.log(message)
      }
     
    });
    ws.on('close', () => {
      console.log("Finished : " + (Date.now() - start) + " ms")
      process.exit()
    });
  })