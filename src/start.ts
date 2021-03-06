import express from 'express';
import { config } from './config/index';
import { contractEventLoader } from './events/loader';
import { Sequelize, SequelizeOptions } from 'sequelize-typescript';
import routesV2 from './routes/index-v2';
import admin from 'firebase-admin';
import morgan from 'morgan';
import bodyParser from 'body-parser';
import cors from 'cors';
import path from 'path';

import helmet from 'helmet';

const app = express();

const corsOrigins = ['https://mtx-labs-prism.netlify.app', 'https://cyberfrens-beta.co'];

if (process.env.NODE_ENV === 'development') corsOrigins.push('*');

const firebaseApp = admin.initializeApp({
	credential: admin.credential.cert({
		projectId: config.firebase.projectId,
		privateKey: config.firebase.privateKey,
		clientEmail: config.firebase.clientEmail,
	}),
});

app.use(morgan('combined'));
app.use(
	cors({
		origin: corsOrigins,
	}),
);
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(helmet());
app.use((req, res, next) => {
	if (!req.db) req.db = db;
	next();
});

app.use('/api/v2', routesV2);

const db = firebaseApp.firestore();

contractEventLoader();

const start = async () => {
	const options: SequelizeOptions = {
		username: config.postgres.user,
		password: config.postgres.pwd,
		database: config.postgres.dbName,
		dialect: 'postgres',
		host: config.postgres.host,
		port: config.postgres.port as number,
		models: [path.resolve(__dirname, './models/*.model.*')],
		modelMatch: (filename, member) => {
			return filename.substring(0, filename.indexOf('.model')) === member.toLowerCase();
		},
		logging: false,
	};
	if (process.env.NODE_ENV !== 'development') {
		options.dialectOptions = {
			ssl: {
				require: true,
				rejectUnauthorized: false,
			},
		};
	}
	const sequelize = new Sequelize(options);

	try {
		await sequelize.sync({ alter: true }); // Drop tables and create them again.
		console.log(
			`Server connected with database engine on host ${config.postgres.host} at ${config.postgres.port}`,
		);
	} catch (e) {
		console.error(`failed synchronizing all models. ${e}`);
		process.exit(-1);
	}

	app.listen(config.server.port, () =>
		console.log(`The Server is listening on ${config.server.port}`),
	);
};

start();
