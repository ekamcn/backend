require('dotenv').config();

// Initialize Express app
const express = require('express');
const app = express();

// Create an HTTP server
const http = require('http');
const server = http.createServer(app);

// Enable Express based CORS
const cors = require('cors');
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE']
}));


// Initialize Socket with CORS
const { Server } = require('socket.io');
const io = new Server(server, {
    maxHttpBufferSize: 1e8, //100MB
    cors: { 
        origin: ['http://127.0.0.1:4000', 'http://localhost:4000','*'],
        methods: ['GET', 'POST']
    },
    pingTimeout: 60000,
});

const shopify = require('./shopify');
const storeRoutes = require('./routes/store.routes');
const path = require('path');

app.use(express.json());
console.log(path.join(__dirname, 'logos'))
app.use(express.static(path.join(__dirname, 'logos')));
app.use(express.urlencoded({ extended: true }));

app.use('/store', storeRoutes);

app.get('/', (req, rsp) => {
    rsp.send('Welcome!!');
});

io.on('connection', (socket) => {
    console.log('WebSocket client connected', socket.id);

    /*const ptyProcess = pty.spawn(shell, [], {
        name: 'xterm-color',
        cols: 80,
        rows: 30,
        cwd: process.env.HOME,
        env: process.env
    });

    ptyProcess.on('data', (data) => {
        socket.emit('output', data);
    });

    socket.on('input', (data) => {
        ptyProcess.write(data);
    });

    socket.on('disconnect', () => {
        ptyProcess.kill(); // Terminate the pty process when client disconnects
    });*/

    shopify(io, socket);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});