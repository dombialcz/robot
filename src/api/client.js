import WebSocket from 'ws';
import { SMA, RSI, Stochastic } from 'technicalindicators';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';

dotenv.config();

const XTB_DEMO_URL = 'wss://ws.xtb.com/demo';
const SYMBOL = 'BITCOIN';

// Trading strategy parameters
const RSI_OVERBOUGHT = 70;
const RSI_OVERSOLD = 30;
const STOCH_OVERBOUGHT = 80;
const STOCH_OVERSOLD = 20;

// Risk management parameters
const ACCOUNT_RISK_PERCENT = 2; // Risk 2% of account per trade
const STOP_LOSS_PERCENT = 1.5; // 1.5% stop loss from entry
const TAKE_PROFIT_RATIO = 2; // Risk:Reward ratio of 1:2
const MIN_POSITION_SIZE = 0.001; // Minimum BTC position size
const MAX_POSITION_SIZE = 1.0; // Maximum BTC position size
const MAX_DAILY_LOSS_PERCENT = 5; // Maximum daily loss percentage

class Trade {
    constructor({ type, entryPrice, size, stopLoss, takeProfit, timestamp }) {
        this.type = type; // 'BUY' or 'SELL'
        this.entryPrice = entryPrice;
        this.size = size;
        this.stopLoss = stopLoss;
        this.takeProfit = takeProfit;
        this.entryTime = timestamp;
        this.exitTime = null;
        this.exitPrice = null;
        this.pnl = null;
        this.status = 'OPEN';
    }

    close(exitPrice, timestamp) {
        this.exitTime = timestamp;
        this.exitPrice = exitPrice;
        this.status = 'CLOSED';
        
        const priceChange = this.type === 'BUY' 
            ? exitPrice - this.entryPrice 
            : this.entryPrice - exitPrice;
        
        this.pnl = priceChange * this.size;
        return this.pnl;
    }
}

class XTBClient {
    constructor() {
        this.ws = null;
        this.sessionId = null;
        this.prices = [];
        this.highs = [];
        this.lows = [];
        this.connected = false;
        this.currentPosition = null;
        this.accountBalance = 10000; // Default demo account balance
        this.trades = [];
        this.dailyStats = {
            date: new Date().toISOString().split('T')[0],
            trades: 0,
            wins: 0,
            losses: 0,
            pnl: 0
        };
        this.logFile = path.join(process.cwd(), 'trading_log.json');
        this.loadTradingHistory();
    }

    async loadTradingHistory() {
        try {
            const data = await fs.readFile(this.logFile, 'utf8');
            const history = JSON.parse(data);
            this.trades = history.trades.map(t => Object.assign(new Trade({}), t));
            this.dailyStats = history.dailyStats;
        } catch (err) {
            console.log('No trading history found, starting fresh');
        }
    }

    async saveTradingHistory() {
        const data = {
            trades: this.trades,
            dailyStats: this.dailyStats
        };
        await fs.writeFile(this.logFile, JSON.stringify(data, null, 2));
    }

    connect() {
        this.ws = new WebSocket(XTB_DEMO_URL);

        this.ws.on('open', () => {
            console.log('Connected to XTB API');
            this.login();
        });

        this.ws.on('message', (data) => {
            const response = JSON.parse(data.toString());
            console.log('Received message:', JSON.stringify(response));
            this.handleMessage(response);
        });

        this.ws.on('error', (error) => {
            console.error('WebSocket error:', error);
        });

        this.ws.on('close', () => {
            console.log('Disconnected from XTB API');
            this.connected = false;
            setTimeout(() => this.connect(), 5000);
        });
    }

    login() {
        const loginCmd = {
            command: "login",
            arguments: {
                userId: process.env.XTB_USER_ID,
                password: process.env.XTB_PASSWORD
            }
        };
        this.sendCommand(loginCmd);
    }

    sendCommand(cmd) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            console.log('Sending command:', JSON.stringify(cmd));
            this.ws.send(JSON.stringify(cmd));
        }
    }

    async executeTrade(signal, price) {
        // Check daily loss limit
        if (this.dailyStats.pnl < -(this.accountBalance * (MAX_DAILY_LOSS_PERCENT / 100))) {
            console.log('⛔ Daily loss limit reached. No more trades today.');
            return;
        }

        const riskAmount = this.accountBalance * (ACCOUNT_RISK_PERCENT / 100);
        const stopLoss = price * (1 + (signal.action === 'BUY' ? -STOP_LOSS_PERCENT : STOP_LOSS_PERCENT) / 100);
        const takeProfit = price * (1 + (signal.action === 'BUY' ? TAKE_PROFIT_RATIO : -TAKE_PROFIT_RATIO) * (STOP_LOSS_PERCENT / 100));
        
        // Calculate position size based on risk
        let positionSize = riskAmount / Math.abs(price - stopLoss);
        
        // Apply position size limits
        positionSize = Math.max(MIN_POSITION_SIZE, Math.min(positionSize, MAX_POSITION_SIZE));

        const trade = new Trade({
            type: signal.action,
            entryPrice: price,
            size: positionSize,
            stopLoss,
            takeProfit,
            timestamp: new Date().toISOString()
        });

        // Execute trade command
        const tradeCmd = {
            command: "tradeTransaction",
            arguments: {
                tradeTransInfo: {
                    cmd: signal.action === 'BUY' ? 0 : 1,
                    customComment: "API_TRADE",
                    expiration: 0,
                    offset: 0,
                    order: 0,
                    price: price,
                    sl: stopLoss,
                    symbol: SYMBOL,
                    tp: takeProfit,
                    type: 0,
                    volume: positionSize
                }
            }
        };

        this.sendCommand(tradeCmd);
        this.trades.push(trade);
        this.dailyStats.trades++;
        await this.saveTradingHistory();

        console.log(`
🔔 Trade Executed:
Type: ${signal.action}
Price: $${price}
Size: ${positionSize.toFixed(4)} BTC
Stop Loss: $${stopLoss}
Take Profit: $${takeProfit}
Risk: $${riskAmount.toFixed(2)} (${ACCOUNT_RISK_PERCENT}% of account)
`);
    }

    async checkAndUpdatePositions(currentPrice) {
        const openTrades = this.trades.filter(t => t.status === 'OPEN');
        
        for (const trade of openTrades) {
            if (trade.type === 'BUY') {
                if (currentPrice >= trade.takeProfit || currentPrice <= trade.stopLoss) {
                    const pnl = trade.close(currentPrice, new Date().toISOString());
                    this.dailyStats.pnl += pnl;
                    if (pnl > 0) this.dailyStats.wins++;
                    else this.dailyStats.losses++;
                    this.accountBalance += pnl;
                    await this.saveTradingHistory();
                }
            } else { // SELL
                if (currentPrice <= trade.takeProfit || currentPrice >= trade.stopLoss) {
                    const pnl = trade.close(currentPrice, new Date().toISOString());
                    this.dailyStats.pnl += pnl;
                    if (pnl > 0) this.dailyStats.wins++;
                    else this.dailyStats.losses++;
                    this.accountBalance += pnl;
                    await this.saveTradingHistory();
                }
            }
        }
    }

    calculateIndicators() {
        if (this.prices.length < 14) return null;

        const values = this.prices.slice(-14);
        const highValues = this.highs.slice(-14);
        const lowValues = this.lows.slice(-14);
        
        const sma = new SMA({ period: 14, values });
        const rsi = new RSI({ period: 14, values });
        const stoch = new Stochastic({
            period: 14,
            signalPeriod: 3,
            high: highValues,
            low: lowValues,
            close: values
        });

        return {
            sma: sma.getResult().slice(-1)[0],
            rsi: rsi.getResult().slice(-1)[0],
            stoch: stoch.getResult().slice(-1)[0]
        };
    }

    evaluateTradeSignal(indicators) {
        if (!indicators || !indicators.rsi || !indicators.stoch) return null;

        const { rsi, stoch } = indicators;
        const { k, d } = stoch;

        // Only trade if we have no open positions
        if (this.trades.some(t => t.status === 'OPEN')) return null;

        // Buy signals
        if (rsi < RSI_OVERSOLD && k < STOCH_OVERSOLD && d < STOCH_OVERSOLD) {
            if (this.currentPosition !== 'buy') {
                this.currentPosition = 'buy';
                return {
                    action: 'BUY',
                    reason: `RSI(${rsi.toFixed(2)}) and Stochastic(K:${k.toFixed(2)}, D:${d.toFixed(2)}) indicate oversold conditions`
                };
            }
        }
        // Sell signals
        else if (rsi > RSI_OVERBOUGHT && k > STOCH_OVERBOUGHT && d > STOCH_OVERBOUGHT) {
            if (this.currentPosition !== 'sell') {
                this.currentPosition = 'sell';
                return {
                    action: 'SELL',
                    reason: `RSI(${rsi.toFixed(2)}) and Stochastic(K:${k.toFixed(2)}, D:${d.toFixed(2)}) indicate overbought conditions`
                };
            }
        }

        return null;
    }

    getPerformanceMetrics() {
        const closedTrades = this.trades.filter(t => t.status === 'CLOSED');
        const totalTrades = closedTrades.length;
        const winningTrades = closedTrades.filter(t => t.pnl > 0).length;
        const totalPnL = closedTrades.reduce((sum, t) => sum + t.pnl, 0);
        
        return {
            totalTrades,
            winRate: totalTrades ? (winningTrades / totalTrades * 100).toFixed(2) : 0,
            totalPnL: totalPnL.toFixed(2),
            accountBalance: this.accountBalance.toFixed(2),
            dailyPnL: this.dailyStats.pnl.toFixed(2),
            dailyWinRate: this.dailyStats.trades ? 
                (this.dailyStats.wins / this.dailyStats.trades * 100).toFixed(2) : 0
        };
    }

    async handleMessage(response) {
        if (response.status === false) {
            console.error('API Error:', response.errorCode, response.errorDescr);
            return;
        }

        if (response.streamSessionId) {
            this.sessionId = response.streamSessionId;
            this.connected = true;
            console.log('Successfully logged in, starting price stream...');
            this.startStreaming();
            return;
        }

        if (response.data) {
            const { ask, high, low } = response.data;
            this.prices.push(ask);
            this.highs.push(high);
            this.lows.push(low);

            if (this.prices.length > 100) {
                this.prices.shift();
                this.highs.shift();
                this.lows.shift();
            }

            // Check and update existing positions
            await this.checkAndUpdatePositions(ask);

            const indicators = this.calculateIndicators();
            const signal = indicators ? this.evaluateTradeSignal(indicators) : null;
            
            if (signal) {
                await this.executeTrade(signal, ask);
            }

            const metrics = this.getPerformanceMetrics();
            
            console.log(`
Bitcoin Price: $${ask}
${indicators ? `SMA(14): $${indicators.sma.toFixed(2)}
RSI(14): ${indicators.rsi.toFixed(2)}
Stochastic K: ${indicators.stoch.k.toFixed(2)}
Stochastic D: ${indicators.stoch.d.toFixed(2)}` : 'Collecting data for indicators...'}
${signal ? `\n🚨 SIGNAL: ${signal.action}\nReason: ${signal.reason}` : ''}

Performance Metrics:
------------------
Account Balance: $${metrics.accountBalance}
Total P&L: $${metrics.totalPnL}
Win Rate: ${metrics.winRate}%
Total Trades: ${metrics.totalTrades}
Daily P&L: $${metrics.dailyPnL}
Daily Win Rate: ${metrics.dailyWinRate}%
-------------------`);
        }
    }

    startStreaming() {
        if (!this.connected) return;
        
        const streamCmd = {
            command: "getTickPrices",
            symbol: SYMBOL,
            minArrivalTime: 1000,
            maxLevel: 2,
            streamSessionId: this.sessionId
        };

        console.log('Starting price stream...');
        this.sendCommand(streamCmd);
    }
}

// Create and start the client
const client = new XTBClient();
client.connect();