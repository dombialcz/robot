import WebSocket from 'ws';
import dotenv from 'dotenv';

dotenv.config();

const XTB_DEMO_URL = 'wss://ws.xtb.com/demo';
const XTB_STREAM_URL = 'wss://ws.xtb.com/demoStream';
const SYMBOL = 'EURUSD';

class XTBTestClient {
    constructor() {
        this.mainSocket = null;
        this.streamSocket = null;
        this.sessionId = null;
        this.connected = false;
    }

    connect() {
        console.log('Connecting to XTB main socket...');
        this.mainSocket = new WebSocket(XTB_DEMO_URL);

        this.mainSocket.on('open', () => {
            console.log('Connected to XTB main socket');
            this.login();
        });

        this.mainSocket.on('message', (data) => {
            const message = JSON.parse(data.toString());
            this.handleMainMessage(message);
        });

        this.mainSocket.on('error', (error) => {
            console.error('Main socket error:', error);
        });

        this.mainSocket.on('close', () => {
            console.log('Disconnected from XTB main socket');
            this.connected = false;
            setTimeout(() => this.connect(), 5000);
        });
    }

    connectStream() {
        console.log('Connecting to XTB stream socket...');
        this.streamSocket = new WebSocket(XTB_STREAM_URL);

        this.streamSocket.on('open', () => {
            console.log('Connected to XTB stream socket');
            this.startPriceStream();
        });

        this.streamSocket.on('message', (data) => {
            const message = JSON.parse(data.toString());
            this.handleStreamMessage(message);
        });

        this.streamSocket.on('error', (error) => {
            console.error('Stream socket error:', error);
        });

        this.streamSocket.on('close', () => {
            console.log('Disconnected from XTB stream socket');
            setTimeout(() => this.connectStream(), 5000);
        });
    }

    login() {
        console.log('Logging in...');
        const loginCmd = {
            command: "login",
            arguments: {
                userId: process.env.XTB_USER_ID,
                password: process.env.XTB_PASSWORD
            }
        };
        this.sendCommand(this.mainSocket, loginCmd);
    }

    sendCommand(socket, cmd) {
        if (socket && socket.readyState === WebSocket.OPEN) {
            console.log('Sending command:', JSON.stringify(cmd));
            socket.send(JSON.stringify(cmd));
        }
    }

    handleMainMessage(message) {
        console.log('Main socket message:', JSON.stringify(message));

        if (message.streamSessionId) {
            this.sessionId = message.streamSessionId;
            this.connected = true;
            console.log('Successfully logged in with session ID:', this.sessionId);
            this.connectStream();
        }
    }

    handleStreamMessage(message) {
        if (message.data) {
            const { ask, bid, high, low, timestamp } = message.data;
            console.log(`
Bitcoin Price Update:
Time: ${new Date(timestamp).toLocaleTimeString()}
Ask: $${ask}
Bid: $${bid}
High: $${high}
Low: $${low}
`);
        }
    }

    startPriceStream() {
        console.log('Starting price stream...');
        const streamCmd = {
            command: "getTickPrices",
            streamSessionId: this.sessionId,
            symbol: SYMBOL
        };
        this.sendCommand(this.streamSocket, streamCmd);
    }
}

// Create and start the test client
const testClient = new XTBTestClient();
testClient.connect();