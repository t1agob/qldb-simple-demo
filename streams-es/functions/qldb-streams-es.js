/*
 * Lambda function that consumes messages from a Kinesis data stream that uses the
 * Kinesis Aggregated Data Format
 */

const Log = require('@dazn/lambda-powertools-logger');
const {  sendRequest } = require('./helper/es-licence');
const deagg = require('aws-kinesis-agg');
let ion = require("ion-js");


const computeChecksums = true;
const REVISION_DETAILS = 'REVISION_DETAILS';

module.exports.handler = async (event, context) => {
  console.log(`** PRINT MSG: ${JSON.stringify(event, null, 2)}`);
  Log.debug(`Processing  ${event.Records.length} Kinesis Input Records`);

  await Promise.all(
    event.Records.map(async (kinesisRecord) => {
      const records = await promiseDeaggregate(kinesisRecord.kinesis);
      await processRecords(records);
    })
  );
  Log.debug(`Finished processing in qldb-stream handler`);
}


/**
 * Promisified function to deaggregate Kinesis record
 * @param record An individual Kinesis record from the aggregated records
 * @returns The resolved Promise object containing the deaggregated records
 */
const promiseDeaggregate = (record) =>
  new Promise((resolve, reject) => {
    deagg.deaggregateSync(record, computeChecksums, (err, responseObject) => {
      if (err) {
        //handle/report error
        return reject(err);
      }
      return resolve(responseObject);
    });
});

/**
 * Processes each deaggregated Kinesis record in order. The function
 * ignores all records apart from those of typee REVISION_DETAILS
 * @param records The deaggregated Kinesis records to be processed
 */
async function processRecords(records) {
  await Promise.all(
    records.map(async (record) => {
      // Kinesis data is base64 encoded so decode here
      const payload = Buffer.from(record.data, "base64");

      // payload is the actual ion binary record published by QLDB to the stream
      const ionRecord = ion.load(payload);

      // Only process records where the record type is REVISION_DETAILS
      if (JSON.parse(ion.dumpText(ionRecord.recordType)) !== REVISION_DETAILS) {
        console.log(`Skipping record of type ${ion.dumpPrettyText(ionRecord.recordType)} with payload 
          ${ion.dumpPrettyText(ionRecord.payload)}`);
      } else {
        console.log(`Ion Record: ${ion.dumpPrettyText(ionRecord.payload)}`);
        await processIon(ionRecord);
      }
    })
  );
}

/**
 * Processes each Ion record, and takes the appropriate action to 
 * create, update or delete a record in DynamoDB
 * @param ionRecord The Ion data loaded from a Uint8Array
 */
async function processIon(ionRecord) {
  // retrieve the version and id from the metadata section of the message
  const version = parseInt(ion.dumpText(ionRecord.payload.revision.metadata.version));
  const id = ion
    .dumpText(ionRecord.payload.revision.metadata.id)
    .replace(/['"]+/g, "");
  const revision = ion.dumpText(ionRecord.payload.revision);
  let response;

  // Check to see if the data section exists.
  if (ionRecord.payload.revision.data == null) {
    Log.debug(`No data section so handle as a delete`);
    response = await sendRequest({ httpMethod: 'DELETE', requestPath: `/licence/_doc/${id}?version=${version}&version_type=external`});
    console.log(`RESPONSE: ` + JSON.stringify(response));

  } else {
    const points = parseInt(ion.dumpText(ionRecord.payload.revision.data.PenaltyPoints));
    const postcode = ion
      .dumpText(ionRecord.payload.revision.data.Postcode)
      .replace(/['"]+/g, "");

    const licenceId = ion
      .dumpText(ionRecord.payload.revision.data.LicenceId)
      .replace(/['"]+/g, "");
    
    Log.debug(`id: ${id}, points: ${points}, postcode: ${postcode}. licenceId: ${licenceId}`);

    const doc = {
      "licenceId": licenceId,
      "points": points,
      "postcode": postcode,
      "version": version
    };
    console.log('About to create/update a record in elasticsearch');
    response = await sendRequest({ httpMethod: 'PUT', requestPath: `/licence/_doc/${id}?version=${version}&version_type=external`, payload: doc });
    console.log(`RESPONSE: ` + JSON.stringify(response));
  }
}