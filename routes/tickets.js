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

router.post('/webhook/mercadopago', async (req, res) => {
    console.log('🔔 Webhook recebido:', JSON.stringify(req.body, null, 2));
    res.sendStatus(200);

    const paymentId = req.body.data?.id;
    const topic = req.body.type;

    if (topic !== 'payment' || !paymentId) {
        console.warn('⚠️ Webhook ignorado: topic diferente de payment ou paymentId ausente');
        return;
    }

    try {
        const response = await payment.get({ id: paymentId });
        const data = response;
        console.log('🔍 Dados do pagamento:', JSON.stringify(data, null, 2));

        const status = data.status;
        const userId = data.metadata.userId;
        const email = data.payer.email;
        const userTicket = data.metadata.userTicket
        const amount = data.transaction_amount;

        console.log(`💰 Status: ${status}, Ticket: ${userTicket}, Valor: ${amount}`);

        const { data: ticket, error: fetchError } = await supabase
            .from('tickets')
            .select('*')
            .eq('id', userTicket)
            .eq('status', 'pending')
            .limit(1)
            .single();

        if (fetchError || !ticket) {
            console.error('❌ Ticket não encontrado:', fetchError);
            return;
        }

        let qrcodeData = null;
        if (status === 'approved') {
            qrcodeData = {
                ticket_id: ticket.id,
                payment_id: paymentId,
                quantidade: ticket.quantidade,
                buyer_email: email
            };
        }

        const { error: updateError } = await supabase
            .from('tickets')
            .update({
                status: status,
                payment_id: paymentId,
                qrcode_data: qrcodeData,
                updated_at: new Date()
            })
            .eq('id', ticket.id);

        if (updateError) {
            console.error('❌ Erro ao atualizar ticket:', updateError);
        } else {
            console.log('✅ Ticket atualizado com sucesso!');
            if (status === 'approved') {
                // 🔥 Aqui você pode disparar o envio de e-mail com QRCode
                console.log('📧 Enviar email com QRCode...');
            }
        }
    } catch (err) {
        console.error('❌ Erro ao consultar pagamento:', err);
    }
});

// ========== ROTA: Resumo + Criação de Preference no Mercado Pago ==========
router.get('/summary', async (req, res) => {
    try {
        const qty = parseInt(req.query.qtd, 10);
        const userId = req.query.userId;
        console.log(" userId:", userId)

        if (!qty || qty <= 0) {
            return res.status(400).send('Quantidade inválida.');
        }

        const unitPrice = 1;
        const total = unitPrice * qty;

        const { data: users, error: errorUser } = await supabase
            .from('Users')
            .select('*')
            .eq('id', userId)
            .maybeSingle();

        if (errorUser) {
            console.error('❌ Erro ao buscar usuário no banco:', errorUser);
            return res.status(500).send('Erro ao buscar usuário.');
        }

        const { data: ticket, error: errorTickets } = await supabase
            .from('tickets')
            .insert([{
                user_id: userId,
                buyer_email: users.email || null,
                status: 'pending',
                quantidade: qty,
                qrcode_data: null,
                created_at: new Date(),
                updated_at: new Date(),
                payment_id: null
            }])
            .select();

        if (errorTickets) {
            console.error('❌ Erro ao criar ticket no banco:', errorTickets);
            return res.status(500).send('Erro ao criar ticket.');
        }

        console.log("Ingresso: ", ticket)

        const preference = await new Preference(mercadopago).create({
            body: {
                items: [
                    {
                        title: 'Ingresso Copinha ECG',
                        quantity: qty,
                        currency_id: 'BRL',
                        unit_price: unitPrice,
                    }
                ],
                payment_methods: {
                    excluded_payment_types: [],
                    excluded_payment_methods: [],
                    installments: 2,
                },
                back_urls: {
                    success: 'https://copinha-ecg.onrender.com/success',
                    failure: 'https://copinha-ecg.onrender.com/failure',
                    pending: 'https://copinha-ecg.onrender.com/pending',
                },
                auto_return: 'approved',
                metadata: {
                    qty,
                    userTicket: ticket.id || '',
                    userId: users.id || '',
                }
            }
        });

        res.render('tickets/summary', {
            qty,
            unitPrice,
            total,
            preferenceId: preference.id,
            publicKey: process.env.MERCADO_PAGO_PUBLIC_KEY
        });

    } catch (err) {
        console.error('❌ Erro na rota /summary:', err);
        res.status(500).send('Erro no pagamento');
    }
});

// ========== ROTA: Sucesso do pagamento – gravar no banco e renderizar página “Obrigado” ==========
router.get('/success', async (req, res) => {
    try {
        const { collection_id, collection_status, preference_id } = req.query;

        if (collection_status !== 'approved') {
            return res.send('Pagamento não aprovado.');
        }

        const paymentInfo = await payment.get(collection_id);
        const payment = paymentInfo;

        const qty = payment.additional_info.items[0].quantity;
        const total = Math.round(payment.transaction_amount * 100);

        const { data, error } = await supabase
            .from('Tickets')
            .insert({
                quantity: qty,
                amount: total,
                preference_id: preference_id,
                payment_id: collection_id,
                status: 'approved'
            });

        if (error) console.error('Erro ao salvar ticket:', error);

        res.render('tickets/thankyou');
    } catch (err) {
        console.error(err);
        res.status(500).send('Erro no sucesso');
    }
});

// ========== Rotas opcionais para failure/pending (caso queira) ==========
router.get('/failure', (req, res) => {
    return res.send('Pagamento não concluído. Você pode tentar novamente.');
});

router.get('/pending', (req, res) => {
    return res.send('Pagamento em análise. Assim que confirmado, enviaremos um e-mail com instruções.');
});

router.get('/dashboard', async (req, res) => {
    let paymentSuccess, paymentPedding;
    const { data: dataSuccess, error: errorSuccess, count: countSuccess } = await supabase
        .from('Cadeiras')
        .select('payment', { count: 'exact' })
        .eq('payment', 'S');
    if (errorSuccess) return res.status(500).json({ error: errorSuccess.message });
    paymentSuccess = countSuccess;

    const { data: dataPedding, error: errorPedding, count: countPedding } = await supabase
        .from('Cadeiras')
        .select('payment', { count: 'exact' })
        .eq('payment', 'P');
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

router.get('/search-seats-pending/:cpf', async (req, res) => {
    const { cpf } = req.params;
    const { data, error } = await supabase
        .from('Users')
        .select('id')
        .eq('cpf', cpf);
    if (error) return res.status(500).json({ error: error.message });
    if (data.length == 0) return res.status(500).json({ error: "CPF não encontrado" });
    const idUser = data[0].id;
    const { data: lugares, error: errorLugares } = await supabase
        .from('Cadeiras')
        .select()
        .eq('user', idUser)
        .eq('payment', 'P');
    if (error) return res.status(500).json({ error: errorLugares.message });
    res.json({ cadeiras: lugares });
});

router.get('/search-seats-pending-general', async (req, res) => {
    const { data, error } = await supabase
        .from('Cadeiras')
        .select()
        .eq('payment', 'P');
    if (error) return res.status(500).json({ error: error.message });
    res.json({ cadeiras: data });
});

router.get('/search-seats-general/:userId', async (req, res) => {
    const { userId } = req.params;
    const { data, error } = await supabase
        .from('Cadeiras')
        .select()
        .eq('payment', 'S')
        .eq('user', userId);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ cadeiras: data });
});

router.get('/search-seats-paid/:cpf', async (req, res) => {
    const { cpf } = req.params;
    const { data, error } = await supabase
        .from('Users')
        .select('id')
        .eq('cpf', cpf);
    if (error) return res.status(500).json({ error: error.message });
    if (data.length == 0) return res.status(500).json({ error: "CPF não encontrado" });
    const idUser = data[0].id;
    const { data: lugares, error: errorLugares } = await supabase
        .from('Cadeiras')
        .select()
        .eq('user', idUser)
        .eq('payment', 'S');
    if (error) return res.status(500).json({ error: errorLugares.message });
    res.json({ cadeiras: lugares });
});

router.get('/download-tickets/:idCadeira', async (req, res) => {
    const { idCadeira } = req.params;

    console.log(`[INFO] Iniciando geração do ticket para idCadeira: ${idCadeira}`);

    async function generateQRCode(data) {
        try {
            return await QRCode.toBuffer(JSON.stringify(data));
        } catch (err) {
            console.error('[ERROR] Erro ao gerar QR Code:', err);
            throw err;
        }
    }

    function measureTextWidth(text, font) {
        const canvas = createCanvas(1, 1);
        const context = canvas.getContext('2d');
        context.font = font;
        return context.measureText(text).width;
    }

    async function createEventTicket(user) {
        try {
            const sessao = user.sessao == 1 ? 'sessao1.png' : 'sessao2.png';
            console.log(`[INFO] Selecionando imagem da sessão: ${sessao}`);
            const image = await Jimp.read(path.join(__dirname, '..', 'public', 'images', sessao));

            const fontPath = path.join(__dirname, '..', 'public', 'fonts', 'open-sans', 'open-sans-32-white', 'open-sans-32-white.fnt');
            const font = await Jimp.loadFont(fontPath);
            console.log('[INFO] Fonte carregada com sucesso.');

            const text1 = `${user.nome} | ${user.cpf}`;
            const text2 = `Sessão: ${user.sessao}, Andar: ${user.andar}, Fileira: ${user.fileira}, Poltrona: ${user.numero}`;

            const textWidth1 = measureTextWidth(text1, "32px Arial");
            const textWidth2 = measureTextWidth(text2, "32px Arial");
            const centerX = image.bitmap.width / 2;

            // Ajusta a posição do texto de acordo com a resolução da imagem
            const margin = 20; // margem para não colar nas bordas
            const adjustedCenterX1 = Math.min(centerX - (textWidth1 / 2), image.bitmap.width - margin);
            const adjustedCenterX2 = Math.min(centerX - (textWidth2 / 2), image.bitmap.width - margin);

            // Ajusta para a largura máxima da imagem (evita que texto ultrapasse as bordas)
            image.print(font, 15, 590, text1);
            image.print(font, 10, 625, text2);

            const qrCode = await generateQRCode(user);
            const qrImage = await Jimp.read(qrCode);
            qrImage.resize(300, 300);
            image.composite(qrImage, 210, 700);

            console.log('[INFO] QR Code adicionado ao ticket.');

            return new Promise((resolve, reject) => {
                image.getBuffer(Jimp.MIME_PNG, (err, buffer) => {
                    if (err) {
                        console.error('[ERROR] Erro ao converter imagem em buffer:', err);
                        reject(err);
                    } else {
                        console.log('[INFO] Ticket gerado com sucesso.');
                        resolve(buffer);
                    }
                });
            });

        } catch (err) {
            console.error('[ERROR] Erro ao criar o ticket:', err);
            throw err;
        }
    }

    try {
        const { data: cadeiraSearch, error: erroCadeiraSearch } = await supabase
            .from('Cadeiras')
            .select()
            .eq('id', idCadeira);

        if (erroCadeiraSearch) {
            console.error('[ERROR] Erro ao buscar cadeira no Supabase:', erroCadeiraSearch);
            return res.status(500).json({ message: 'Erro ao buscar cadeira', erro: erroCadeiraSearch });
        }

        if (!cadeiraSearch || cadeiraSearch.length === 0) {
            console.error('[ERROR] Cadeira não encontrada.');
            return res.status(404).json({ message: 'Cadeira não encontrada.' });
        }

        console.log(`[INFO] Cadeira encontrada: ${JSON.stringify(cadeiraSearch[0])}`);

        const { data: user, error: erroUser } = await supabase
            .from('Users')
            .select()
            .eq('id', cadeiraSearch[0].user);

        if (erroUser) {
            console.error('[ERROR] Erro ao buscar usuário no Supabase:', erroUser);
            return res.status(500).json({ message: 'Erro ao buscar usuário', erro: erroUser });
        }

        if (!user || user.length === 0) {
            console.error('[ERROR] Usuário não encontrado.');
            return res.status(404).json({ message: 'Usuário não encontrado.' });
        }

        console.log(`[INFO] Usuário encontrado: ${JSON.stringify(user[0])}`);

        if (!cadeiraSearch[0].qrcode_content || cadeiraSearch[0].qrcode_content == null) {
            console.error('[ERROR] qrcode_content está vazio ou nulo.');
            return res.status(500).json({ message: 'qrcode_content é nulo' });
        }

        const userJson = {
            ...cadeiraSearch[0].qrcode_content,
            email: user[0].email,
            nome: user[0].nome,
        };

        console.log(`[INFO] Dados para geração do ticket: ${JSON.stringify(userJson)}`);

        const ticketBuffer = await createEventTicket(userJson);

        res.set('Content-Type', 'image/png');
        res.set('Content-Disposition', `attachment; filename=ticket_${idCadeira}.png`);
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

/*router.get('/created-qrcode-json', async (req, res) => {
    let qtd_cadeiras = 0;
    const { data: users, error: errorUsers } = await supabase
        .from('Users')
        .select('*');

    if (errorUsers) {
        console.error('Erro ao buscar usuários:', errorUsers);
        return res.status(500).send('Erro ao buscar usuários');
    }

    for (const user of users) {
        console.log(user)
        const { data: cadeiras, error: errorCadeiras } = await supabase
            .from('Cadeiras')
            .select('*')
            .eq('user', user.id)
            .eq('payment', 'S')
            .eq('disponivel', false);

        if (errorCadeiras) {
            console.error(`Erro ao buscar cadeiras para o usuário ${user.id}:`, errorCadeiras);
            continue;
        }
        for (const cadeira of cadeiras) {
            const qrcodeContent = {
                idUser: user.id,
                sessao: cadeira.sessao,
                andar: cadeira.andar,
                fileira: cadeira.fileira,
                numero: cadeira.numero,
                cpf: user.cpf,
            };

            const { error: errorUpdate } = await supabase
                .from('Cadeiras')
                .update({ qrcode_content: qrcodeContent })
                .eq('id', cadeira.id);

            if (errorUpdate) {
                console.error(`Erro ao atualizar cadeira ${cadeira.id} do usuário ${user.id}:`, errorUpdate);
            } else {
                console.log(`QR code atualizado para a cadeira ${cadeira.id} do usuário ${user.id}`);
            }
        }
        qtd_cadeiras += 1;
    }
    console.log("quantidade de cadeiras modificadas: " + qtd_cadeiras);
    res.status(200).send();
});*/

module.exports = router;
