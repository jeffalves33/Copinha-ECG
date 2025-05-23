// server.js
const express = require('express');
const bodyParser = require('body-parser');
const app = express();
const port = 3000;
const path = require('path');

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.json());

const indexRouter = require('./routes/index');
const ticketsRouter = require('./routes/tickets');

app.use('/', indexRouter);
app.use('/', ticketsRouter);
app.use('/tickets', ticketsRouter);

app.listen(port, () => {
    console.log(`App rodando em http://localhost:${port}`);
});
