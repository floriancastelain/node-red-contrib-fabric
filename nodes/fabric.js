/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';
module.exports = function (RED) {
    const util = require('util');
    const fabricNetwork = require('fabric-network');
    const fabricClient = require('fabric-client');

    var eventHandlers = [];
    let gateway = new fabricNetwork.Gateway();
    let network;


    /**
     *
     * @param {string} identityName identityName
     * @param {string} channelName channel
     * @param {string}contractName contract
     * @returns {PromiseLike<Contract | never>} promise
     */
    async function connect(identityName, channelName, contractName, node) {
        node.log(`connect ${identityName} ${channelName} ${contractName}`);
        const parsedProfile = JSON.parse(node.connection.connectionProfile);
        const client = await fabricClient.loadFromConfig(parsedProfile);
        node.log('loaded client from connection profile');
        const mspid = client.getMspid();
        node.log('got mspid,' + mspid);
        const wallet = new fabricNetwork.FileSystemWallet(node.connection.walletLocation);
        node.log('got wallet');
        const options = {
            wallet: wallet,
            identity: identityName,
            discovery: {
                asLocalhost: true
            }
        };

        await gateway.connect(parsedProfile, options);
        node.log('connected to gateway');
        const network = await gateway.getNetwork(channelName);
        node.log('got network');
        const contract = await network.getContract(contractName);
        node.log('got contract');
        return { contract: contract, network: network };
    }

    /**
     *
     * @param {Contract} contract contract
     * @param {string} payload payload
     * @param {Node} node node
     * @returns {Promise<Buffer>} promise
     */
    function submit(contract, payload, node) {
        node.log(`submit ${payload.transactionName} ${payload.transactionArgs}`);
        return contract.submitTransaction(payload.transactionName, ...payload.transactionArgs);
    }

    /**
     *
     * @param {Contract} contract contract
     * @param {object} payload payload
     * @param {Node} node node
     * @returns {Promise<Buffer>} promise
     */
    function evaluate(contract, payload, node) {
        node.log(`evaluate ${payload.transactionName} ${payload.transactionArgs}`);
        return contract.submitTransaction(payload.transactionName, ...payload.transactionArgs);
    }

    /**
    * 
    * @param {Contract} contract contract
    * @param {object} payload payload
    * @param {Node} node node
    * @returns {Promise<Buffer>} promise
    */
    function query(channel, payload, contractName, node) {
        node.log(`query ${contractName} ${payload.queryFcn} ${payload.queryArgs}`);
        return channel.queryByChaincode({
            chaincodeId: contractName,
            fcn: payload.queryFcn,
            args: payload.queryArgs
        });
    }






    async function subscribeToEvent(contract, contractName, eventName, node, msg) {
        try {
            contract.addContractListener(contractName, eventName,
                (error, event, blockNumber, txId) => {
                    if (error) {
                        console.log(error);
                        return error;
                    } else {
                        msg.payload = {
                            event: event,
                            blockNumber: blockNumber
                        };
                        node.status({});
                        node.send(msg);
                    }
                }, {
                    filtered: false
                });
        } catch (error) {
            return error;
        }

    }



    // /**
    //  *
    //  * @param payload
    //  */
    // function checkPayload(payload) {
    //     if (!payload.transactionName || typeof payload.transactionName !== 'string') {
    //         throw new Error('message should contain a transaction name of type string');
    //     }

    //     if (payload.args && !Array.isArray(payload.args)) {
    //         throw new Error('message args should be an array of strings');
    //     }
    // }

    /**
     * Create a output node
     * @param {object} config The configuration from the node
     * @constructor
     */
    function FabricOutNode(config) {
        let node = this;
        RED.nodes.createNode(node, config);

        node.on('input', async function (msg) {
            this.connection = RED.nodes.getNode(config.connection);
            try {
                const identityName = node.connection.identityName;
                node.log('using connection: ' + identityName);
                node.log('checking payload ' + util.inspect(msg.payload, false, null));
                checkPayload(msg.payload);
                const connectData = await connect(identityName, config.channelName, config.contractName, node);
                if (config.actionType === 'submit') {
                    await submit(connectData.contract, msg.payload, node)
                } else {
                    await evaluate(connectData.contract, msg.payload, node);
                }

            } catch (error) {
                node.status({ fill: 'red', shape: 'dot', text: 'Error' });
                node.error('Error: ' + error.message, msg);
            }
        });

        node.on('close', () => {
            node.log('closing node');
            node.status({});
        });
    }

    RED.nodes.registerType('fabric-out', FabricOutNode);

    /**
     * Create a mid node
     * @param {object} config The configuration set on the node
     * @constructor
     */
    function FabricMidNode(config) {
        let node = this;
        RED.nodes.createNode(node, config);

        node.on('input', async function (msg) {
            this.connection = RED.nodes.getNode(config.connection);
            try {
                console.log(msg.payload);
                //node.log('config ' + util.inspect(node.connection, false, null));
                const identityName = node.connection.identityName;
                var channelName = typeof msg.payload.channelName === "string" ? msg.payload.channelName : config.channelName;
                var contractName = typeof msg.payload.contractName === "string" ? msg.payload.contractName : config.contractName;
                var actionType = typeof msg.payload.actionTypeForm === "string" ? msg.payload.actionTypeForm : config.actionTypeForm;
                node.log('using connection: ' + identityName + " for action " + actionType);
                const networkInfo = await connect(identityName, channelName, contractName, node);
                let result;
                if (actionType === "submit") {
                    result = await submit(networkInfo.contract, msg.payload, node);
                    msg.payload = result;
                    node.status({});
                    node.send(msg);
                } else if (actionType === "evaluate") {
                    result = await evaluate(networkInfo.contract, msg.payload, node);
                    msg.payload = result;
                    node.status({});
                    node.send(msg);
                } else if (actionType === "query") {
                    result = await query(networkInfo.network.getChannel(), msg.payload, contractName, node);
                    msg.payload = result;
                    node.status({});
                    node.send(msg);
                } else if (actionType === "event") {
                    result = await subscribeToEvent(networkInfo.contract, contractName, msg.payload.eventName, node, msg);
                }

            } catch (error) {
                node.status({ fill: 'red', shape: 'dot', text: 'Error' });
                node.error('Error: ' + error.message, msg);
            }
        });

        node.on('close', () => {
            node.status({});
        });
    }

    RED.nodes.registerType('fabric-mid', FabricMidNode);

    /**
        * Create an in node
        * @param {object} config The configuration set on the node
        * @constructor
        */
    function FabricInNode(config) {
        let node = this;
        RED.nodes.createNode(node, config);

        this.connection = RED.nodes.getNode(config.connection);

        // node.log('config ' + util.inspect(node.connection, false, null));
        const identityName = node.connection.identityName;
        node.log('using connection: ' + identityName);
        connect(identityName, config.channelName, config.contractName, node)
            .then((connectData) => {
                // return subscribeToEvent(config.channelName, config.contractName, config.eventName, node);
                return testEvent(connectData.contract, config.contractName, config.eventName)
            })
            .catch((error) => {
                node.status({ fill: 'red', shape: 'dot', text: 'Error' });
                node.error('Error: ' + error.message);
            });
        node.on('close', () => {
            node.status({ fill: 'red', shape: 'ring', text: 'disconnected' });
            node.log('close');
            if (network) {
                node.log('got network so need to unregister');
                const channel = network.getChannel();
                const eventHubs = channel.getChannelEventHubsForOrg();
                eventHubs.forEach((eventHub) => {
                    eventHandlers.forEach((eventHandler) => {
                        node.log('unregistering from chaincode event');
                        eventHub.unregisterChaincodeEvent(eventHandler);
                    });
                });
            }

            if (gateway) {
                node.log('got gateway so disconnect');
                gateway.disconnect();
            }

            node.log('finished close');
        });
    }

    RED.nodes.registerType('fabric-in', FabricInNode);



    /**
   * Create an event listener node
   * @param {object} config The configuration set on the node
   * @constructor
   */
    function FabricEventList(config) {
        let node = this;
        RED.nodes.createNode(node, config);

        node.on('input', async function (msg) {
            this.connection = RED.nodes.getNode(config.connection);
            try {
                const identityName = node.connection.identityName;
                const channelName = typeof msg.payload.channelName === "string" ? msg.payload.channelName : config.channelName;
                const orgName = typeof msg.payload.orgName === "string" ? msg.payload.orgName : config.orgName;
                const walletLocation = typeof msg.payload.walletLocation === "string" ? msg.payload.walletLocation : config.walletLocation;
                const connectionProfile = JSON.parse(node.connection.connectionProfile);
                const peerName = typeof msg.payload.peerName === "string" ? msg.payload.peerName : config.peerName;
                const chaincodeName = typeof msg.payload.contractName === "string" ? msg.payload.contractName : config.contractName;
                const eventName = typeof msg.payload.eventName === "string" ? msg.payload.eventName : config.eventName;
                const startBlock = typeof msg.payload.startBlock === "undefined" ? config.startBlock : msg.payload.startBlock;
                const endBlock = typeof msg.payload.endBlock === "undefined" ? config.endBlock : msg.payload.endBlock;
                const timeout = typeof msg.payload.timeout === "undefined" ? config.timeout : msg.payload.timeout;
                connectToPeer(identityName, channelName, orgName,
                    peerName, connectionProfile, walletLocation)
                    .then((networkData) => {
                        return subscribeToEvent(networkData.peer, networkData.channel,
                            chaincodeName, eventName, startBlock, endBlock, node, msg, timeout)
                    }).catch((error) => {
                        console.log(error);
                        node.status({ fill: 'red', shape: 'dot', text: 'Error' });
                        node.error('Error: ' + error.message);
                    });
            } catch (error) {
                node.status({ fill: 'red', shape: 'dot', text: 'Error' });
                node.error('Error: ' + error.message, msg);
            }
        });
    }

    RED.nodes.registerType('fabric-event-list', FabricEventList);

};

