const websocket = require('ws');
const axios= require('axios');
var jwt = require('jsonwebtoken');
const AudioRecorder = require('node-audiorecorder')
const auth=  "https://asr-lvl.voxist.com/oauth/token"
let socket_url =   'https://asr-lvl.voxist.com/websocket'

const audioRecorder = new AudioRecorder({
    program: 'sox',
    silence: 10
  }, console);
  

axios.post(auth, {grant_type: "password", username: process.argv[2], password: process.argv[3]})
  .then(async (res) => {
    let ws_resp = await axios.get(socket_url, {headers: {authorization: "Bearer " + res.data.access_token}})
    console.log(ws_resp.data)
    const ws = new websocket(ws_resp.data.url);
    let start = Date.now()
    let first = true;
    ws.on('open', () => {
      var readStream = audioRecorder.start().stream();
      start = Date.now()
      ws.send('{"config": {"sample_rate": 16000, "lang" : "fr"}}');
      readStream.on('data',  (chunk) => {
        //console.log("sending audio")
        ws.send(chunk);
      });
      readStream.on('end', async () => {
        console.log("closed")
        ws.send('{"eof" : 1}');
      });
      readStream.on('error', function () {
        console.warn('Recording error.');
      });
      
    });
    ws.on('message', (data) => {
      let message  = JSON.parse(data);
      if(message["Text"] !== ""){
        if(first == true) {
          first = false;
          console.log("First word : " + (Date.now() - start) + " ms")
        }
        console.log(message["Text"])
      }
     
    });
    ws.on('close', () => {
      console.log("Finished : " + (Date.now() - start) + " ms")
      process.exit()
    });
  })