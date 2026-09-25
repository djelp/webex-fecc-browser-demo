import xapi from 'xapi';

const baseUrl = "https://example.ngrok.io";
var serialNumber;

xapi.Status.SystemUnit.Hardware.Module.SerialNumber.get().then(value => {
  console.log(`SerialNumber:${value}`);
  serialNumber = value;
  httpPost("startup");
})


// Enable the HTTP client if it isn't already
xapi.Config.HttpClient.Mode.get().then(value => {
  console.log('HTTP Client is : ' + value);
  if(value == 'Off'){
    console.log('Enabling HTTP Client');
    xapi.Config.HttpClient.Mode.set('On');
  }
});

xapi.Event.IncomingCallIndication.on(event => {
  console.log("IncomingCallIndication");
  console.log(event)
});

xapi.Status.Call.on(event => {
  console.log("Call Event");
  console.log(event);
  if(event["AnswerState"] === "Unanswered"){
    if(event["Direction"] === "Incoming"){//Remove this condition if you want FECC for outgoing calls as well.
      httpPost("call", {"callbackNumber": event["CallbackNumber"]});
    }
  } else if(event["ghost"] === "True"){
    httpPost("call-end");
  }
});

function httpPost(path, data){
  if(!data){
    data = {};
  }
  data.deviceSerial = serialNumber;
  console.log("httpPost path:", path);
  console.log("httpPost data:");
  console.log(JSON.stringify(data));
  xapi.command('HttpClient Post', { 
    Header: ["Content-Type: application/json"], 
    Url: baseUrl + "/" + path,
    ResultBody: 'plaintext',
  }, JSON.stringify(data)).then((result) => {
    console.log(result.Body);
  }).catch((err) => {
    console.log("Error: ");
    console.log(err);
  });
}

