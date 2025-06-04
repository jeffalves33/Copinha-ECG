// routes/tickets.js
require('dotenv').config();
const express = require('express');
const router = express.Router();
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');

const Jimp = require('jimp');
const QRCode = require('qrcode');
const { createCanvas } = require('canvas');
const nodemailer = require('nodemailer');
const { PDFDocument, rgb } = require('pdf-lib');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)

// Configura Mercado Pago
const mercadopago = new MercadoPagoConfig({ accessToken: process.env.MERCADO_PAGO_ACCESS_TOKEN });
const payment = new Payment(mercadopago);

async function generateQRCode(data) {
    try {
        return await QRCode.toBuffer(JSON.stringify(data));
    } catch (err) {
        console.error('[ERROR] Erro ao gerar QR Code:', err);
        throw err;
    }
}

// Função para criar o ticket com QRCode
async function createEventTicket(user) {
    try {
        const image = await Jimp.read(path.join(__dirname, '..', 'public', 'images', 'ticket.png'));
        const fontPath = path.join(__dirname, '..', 'public', 'fonts', 'open-sans', 'open-sans-32-white', 'open-sans-32-white.fnt');
        const font = await Jimp.loadFont(fontPath);

        const imageWidth = 720;
        const text1 = `${user.nome}`;
        const text2 = `Quantidade: ${user.quantidade}`;
        const charWidthEstimate = 18;
        const text1EstimatedWidth = text1.length * charWidthEstimate;
        const text1X = (imageWidth - text1EstimatedWidth) / 2;

        image.print(font, Math.max(0, text1X), 590, text1); // Garante que X não seja negativo

        const text2EstimatedWidth = text2.length * charWidthEstimate;
        const text2X = (imageWidth - text2EstimatedWidth) / 2;
        image.print(font, Math.max(0, text2X), 625, text2);

        const qrCode = await generateQRCode(user);
        const qrImage = await Jimp.read(qrCode);
        qrImage.resize(300, 300);
        image.composite(qrImage, 210, 700);

        return new Promise((resolve, reject) => {
            image.getBuffer(Jimp.MIME_PNG, (err, buffer) => {
                if (err) {
                    console.error('[ERROR] Erro ao converter imagem em buffer:', err);
                    reject(err);
                } else {
                    resolve(buffer);
                }
            });
        });
    } catch (err) {
        console.error('[ERROR] Erro ao criar o ticket:', err);
        throw err;
    }
}

// Função para enviar e-mail
async function sendEmailWithTicket(to, buffer, quantidade) {
    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: 'espetaculoecg@gmail.com',
            pass: 'vykstszlqkynelxw'
        }
    });

    const attachments = [];

    // Loop 'quantidade' times to add the same attachment
    for (let i = 0; i < quantidade; i++) {
        attachments.push({
            filename: `ticket_${i + 1}.png`, // Give each ticket a unique filename
            content: buffer
        });
    }

    const mailOptions = {
        from: '"Copinha ECG" <espetaculoecg@gmail.com>',
        to: to,
        subject: 'Seu ingresso para o evento!',
        text: `Olá! Seguem em anexo seus ${quantidade} ingressos.`,
        attachments: attachments
    };

    await transporter.sendMail(mailOptions);
    console.log('📨 E-mail enviado para:', to);
}

router.post('/webhook/mercadopago', async (req, res) => {
    res.sendStatus(200);

    const paymentId = req.body.data?.id;
    const topic = req.body.type;

    if (topic !== 'payment' || !paymentId) {
        console.warn('⚠️ Webhook ignorado. Motivo: topic diferente de payment ou paymentId ausente');
        return;
    }

    try {
        const response = await payment.get({ id: paymentId });
        const data = response;

        const status = data.status;
        const userId = data.metadata?.user_id;
        const userTicket = data.metadata?.user_ticket;
        const email = data.payer?.email;
        const amount = data.transaction_amount;

        if (!userTicket || !userId) {
            console.warn('⚠️ Metadata incompleta. userTicket ou userId ausente.');
            return;
        }

        console.log(`💰 Status: ${status}, Ticket: ${userTicket}, Valor: ${amount}`);

        const { data: ticket, error: fetchError } = await supabase
            .from('tickets')
            .select('*')
            .eq('id', userTicket)
            .eq('status', 'pending')
            .single();

        if (fetchError) {
            console.error('❌ Erro ao buscar ticket:', fetchError.message);
            return;
        }

        if (!ticket) {
            console.warn(`❗ Ticket não encontrado ou já processado. ID: ${userTicket}`);
            return;
        }

        const qrcodeData = (status === 'approved') ? {
            ticket_id: ticket.id,
            payment_id: paymentId,
            quantidade: ticket.quantidade,
            buyer_email: email
        } : null;

        const { error: updateError } = await supabase
            .from('tickets')
            .update({
                status,
                payment_id: paymentId,
                qrcode_data: qrcodeData,
                updated_at: new Date()
            })
            .eq('id', ticket.id);

        if (updateError) {
            console.error('❌ Erro ao atualizar ticket:', updateError.message);
        } else {
            if (status === 'approved') {
                try {
                    const { data: user, error: erroUser } = await supabase
                        .from('Users')
                        .select()
                        .eq('id', userId);

                    if (erroUser || !user || user.length === 0) {
                        console.error('[ERROR] Erro ao buscar usuário para envio do e-mail:', erroUser);
                        return;
                    }

                    const userJson = {
                        ...qrcodeData,
                        email: user[0].email,
                        nome: user[0].nome,
                    };

                    const ticketBuffer = await createEventTicket(userJson);

                    await sendEmailWithTicket(user[0].email, ticketBuffer, ticket.quantidade);

                    console.log('✅ E-mail com ticket enviado com sucesso!');

                } catch (err) {
                    console.error('❌ Erro ao gerar ticket ou enviar e-mail:', err);
                }
            }
        }


    } catch (err) {
        console.error('❌ Erro na consulta do pagamento ou processamento:', err.message || err);
    }
});

router.get('/summary', async (req, res) => {
    try {
        const qty = parseInt(req.query.qtd, 10);
        const userId = req.query.userId;

        if (!qty || qty <= 0) {
            console.warn('⚠️ Quantidade inválida:', qty);
            return res.status(400).send('Quantidade inválida.');
        }

        if (!userId) {
            console.warn('⚠️ userId ausente na query');
            return res.status(400).send('Usuário não identificado.');
        }

        const unitPrice = 1;
        const total = unitPrice * qty;

        const { data: user, error: errorUser } = await supabase
            .from('Users')
            .select('*')
            .eq('id', userId)
            .single();

        if (errorUser) {
            console.error('❌ Erro ao buscar usuário:', errorUser.message);
            return res.status(500).send('Erro ao buscar usuário.');
        }

        const { data: ticket, error: errorTickets } = await supabase
            .from('tickets')
            .insert([{
                user_id: userId,
                buyer_email: user.email || null,
                status: 'pending',
                quantidade: qty,
                qrcode_data: null,
                created_at: new Date(),
                updated_at: new Date(),
                payment_id: null
            }])
            .select();

        if (errorTickets) {
            console.error('❌ Erro ao criar ticket:', errorTickets.message);
            return res.status(500).send('Erro ao criar ticket.');
        }

        console.log("🎟️ Ticket criado:", ticket[0]);

        const external_reference = "pedido" + userId;

        const preference = await new Preference(mercadopago).create({
            body: {
                items: [{
                    title: 'Ingresso Copinha ECG',
                    quantity: qty,
                    currency_id: 'BRL',
                    unit_price: unitPrice,
                    category_id: "services",
                    description: "Quantidade de ingressos para evento Copinha ECG"
                }],
                payer: {
                    first_name: user.nome || ''
                },
                external_reference: external_reference,
                payment_methods: {
                    excluded_payment_types: [],
                    excluded_payment_methods: [],
                    installments: 2
                },
                back_urls: {
                    success: 'https://copinha-ecg.onrender.com/success',
                    failure: 'https://copinha-ecg.onrender.com/failure',
                    pending: 'https://copinha-ecg.onrender.com/pending'
                },
                auto_return: 'approved',
                metadata: {
                    qty,
                    userTicket: ticket[0].id || '',
                    userId: user.id || ''
                }
            }
        });

        console.log('🧾 Preference criada com sucesso:', preference.id);

        res.render('tickets/summary', {
            qty,
            unitPrice,
            total,
            preferenceId: preference.id,
            publicKey: process.env.MERCADO_PAGO_PUBLIC_KEY
        });

    } catch (err) {
        console.error('❌ Erro na rota /summary:', err.message || err);
        res.status(500).send('Erro no processamento do pagamento.');
    }
});

router.get('/success', async (req, res) => {
    try {
        const { collection_id, collection_status, preference_id } = req.query;

        if (collection_status !== 'approved') {
            return res.send('Pagamento não aprovado.');
        }

        return res.render('tickets/success');

    } catch (err) {
        console.error('❌ Erro na rota /success:', err.message || err);
        return res.status(500).send('Erro no sucesso');
    }
});

router.get('/failure', (req, res) => {
    return res.render('tickets/failure');
});

router.get('/pending', (req, res) => {
    const { collection_id, preference_id } = req.query;

    if (!collection_id || !preference_id) {
        return res.send('Informações de pagamento não encontradas.');
    }

    return res.render('tickets/pending', {
        paymentId: collection_id,
        preferenceId: preference_id
    });
});

router.get('/checkpayment', async (req, res) => {
    const { paymentId } = req.query;

    if (!paymentId) {
        return res.status(400).json({ error: 'paymentId não informado' });
    }

    try {
        const response = await payment.get({ id: paymentId });
        const data = response;

        const status = data.status;

        console.log(`🔍 Verificando pagamento ${paymentId} - Status: ${status}`);

        return res.json({ status });

    } catch (error) {
        console.error('❌ Erro ao verificar pagamento:', error.message || error);
        return res.status(500).json({ error: 'Erro ao verificar pagamento' });
    }
});

router.get('/dashboard', async (req, res) => {
    let paymentSuccess, paymentPedding;
    const { data: dataSuccess, error: errorSuccess, count: countSuccess } = await supabase
        .from('tickets')
        .select('status', { count: 'exact' })
        .eq('status', 'approved');
    if (errorSuccess) return res.status(500).json({ error: errorSuccess.message });
    paymentSuccess = countSuccess;

    const { data: dataPedding, error: errorPedding, count: countPedding } = await supabase
        .from('tickets')
        .select('status', { count: 'exact' })
        .eq('status', 'pending');
    if (errorPedding) return res.status(500).json({ error: errorPedding.message });
    paymentPedding = countPedding;

    res.json({ paymentSuccess: paymentSuccess, paymentPedding: paymentPedding });
});

router.get('/select-tickets', (req, res) => {
    res.render('tickets/select-tickets');
});

router.get('/download-tickets-page', (req, res) => {
    res.render('tickets/download-tickets');
});

router.get('/change-seats', (req, res) => {
    res.render('tickets/change-seats');
});

router.get('/admin', async (req, res) => {
    res.render('tickets/admin');
});

router.get('/confirm-seats', async (req, res) => {
    res.render('tickets/confirm-seats');
});

router.get('/search-password/:cpf', async (req, res) => {
    const { cpf } = req.params;
    const { data, error } = await supabase
        .from('Users')
        .select('senha')
        .eq('cpf', cpf);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ senha: data[0].senha });
});

router.get('/search-password/:cpf/:password', async (req, res) => {
    const { cpf, password } = req.params;
    const { data, error } = await supabase
        .from('Users')
        .select()
        .eq('cpf', cpf);
    if (error) return res.status(500).json({ message: 'Erro na busca', error });
    if (data.length == 1) {
        if (data[0].senha == password) return res.status(200).json({ message: 'Senha correta', user: data[0] });
    }
    return res.status(200).json({ message: 'Senha incorreta', user: null });
});

router.get('/search-seats-general/:userId', async (req, res) => {
    const { userId } = req.params;
    const { data, error } = await supabase
        .from('tickets')
        .select()
        .eq('status', 'approved')
        .eq('user_id', userId);
    if (error) return res.status(500).json({ error: error.message });

    res.json({ tickets: data });
});

router.get('/download-tickets/:ticketId', async (req, res) => {
    const { ticketId } = req.params;

    try {
        const { data: cadeiraSearch, error: erroCadeiraSearch } = await supabase
            .from('tickets')
            .select()
            .eq('id', ticketId);

        if (erroCadeiraSearch) {
            console.error('[ERROR] Erro ao buscar cadeira no Supabase:', erroCadeiraSearch);
            return res.status(500).json({ message: 'Erro ao buscar cadeira', erro: erroCadeiraSearch });
        }

        if (!cadeiraSearch || cadeiraSearch.length === 0) {
            console.error('[ERROR] Cadeira não encontrada.');
            return res.status(404).json({ message: 'Cadeira não encontrada.' });
        }

        const { data: user, error: erroUser } = await supabase
            .from('Users')
            .select()
            .eq('id', cadeiraSearch[0].user_id);

        if (erroUser) {
            console.error('[ERROR] Erro ao buscar usuário no Supabase:', erroUser);
            return res.status(500).json({ message: 'Erro ao buscar usuário', erro: erroUser });
        }

        if (!user || user.length === 0) {
            console.error('[ERROR] Usuário não encontrado.');
            return res.status(404).json({ message: 'Usuário não encontrado.' });
        }

        if (!cadeiraSearch[0].qrcode_data || cadeiraSearch[0].qrcode_data == null) {
            console.error('[ERROR] qrcode_data está vazio ou nulo.');
            return res.status(500).json({ message: 'qrcode_data é nulo' });
        }

        const userJson = {
            ...cadeiraSearch[0].qrcode_data,
            email: user[0].email,
            nome: user[0].nome,
        };

        const ticketBuffer = await createEventTicket(userJson);

        res.set('Content-Type', 'image/png');
        res.set('Content-Disposition', `attachment; filename=ticket_${user[0].id}.png`);
        console.log('[INFO] Enviando ticket para o cliente.');
        return res.send(ticketBuffer);

    } catch (err) {
        console.error('[ERROR] Erro inesperado na geração do ticket:', err);
        return res.status(500).json({ message: 'Erro ao gerar o ticket', error: err.message });
    }
});

router.get('/search-user-cpf/:cpf', async (req, res) => {
    const { cpf } = req.params;
    const { data, error } = await supabase
        .from('Users')
        .select()
        .eq('cpf', cpf);
    if (error) return res.status(500).json({ message: 'Erro na busca', user: null });
    if (data.length == 1) return res.status(200).json({ message: 'Usuário encontrado', user: data });
    return res.status(200).json({ message: 'Usuário não encontrado', user: null });
});

router.get('/login', async (req, res) => {
    res.render('tickets/login');
});

router.get('/register', async (req, res) => {
    res.render('tickets/register');
});

router.post('/authenticate', async (req, res) => {
    const { userName, userCPF, userEmail, userPhoneDecod, password } = req.body;
    const { data, error } = await supabase
        .from('Users')
        .insert({ nome: userName, cpf: userCPF, email: userEmail, phone: userPhoneDecod, senha: password })
        .select()
    if (error) return res.status(500).json({ message: 'Erro ao criar usuário', success: false });
    return res.status(200).json({ message: 'Usuário criado', success: true, user: data[0] });
});

module.exports = router;
