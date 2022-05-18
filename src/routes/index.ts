import { config } from '../config/index';
import { ErrorCode } from '../helpers/enums/error-code';
import express from 'express';
import sharp from 'sharp';
import axios from 'axios';
import { firestore } from 'firebase-admin';
import fs from 'fs';
import pinataSDK from '@pinata/sdk';
import { TokenType } from '../helpers/enums/token-type';

const whiteListAddresses = [
	'0x6BbEF4ce6Fa65d1f009918B00240AB009b40552a',
	'0x7C5CC6d1dC1a297CFbb71A37e1c7a72F519204C1',
	'0x10836d93f39CC896651C210084f98b63E1055529',
];
const pinata = pinataSDK(config.pinata.apiKey, config.pinata.secretKey);

const router = express.Router();

router.get('/', (req, res) => {
	res.send('<h1>Welcome to1</h1>');
});

router.get('/whitelisted/:address', (req, res) => {
	const { address } = req.params;
	if (!address) return res.status(ErrorCode.BAD_REQUEST_400).send('address property not found.');

	const foundAddress = whiteListAddresses.find((addr) => addr === address);
	if (foundAddress) {
		res.send(true);
	} else {
		res.send(false);
	}
});

router.get('/tokens/traits', async (req, res) => {
	let snapshots;
	try {
		snapshots = await req.db
			.collection(config.firebase.collectionNames.tokens)
			.where('tokenType', '==', TokenType.Trait)
			.get();
	} catch (e) {
		return res
			.status(ErrorCode.INTERNAL_SERVER_ERROR_500)
			.send(`Failed to get all tokens in the collection.`);
	}

	const tokens: firestore.DocumentData = snapshots.docs.map((doc: firestore.DocumentSnapshot) =>
		doc.data(),
	);

	res.send({ tokens: tokens });
});

router.get('/tokens/:tokenId', async (req, res) => {
	const { tokenId } = req.params || {};
	if (!tokenId) return res.status(ErrorCode.BAD_REQUEST_400).send('Please provider params');

	// db.collection('tokens').doc(tokenId)
	const docRef = await req.db.collection(config.firebase.collectionNames.tokens).doc(tokenId).get();
	if (docRef.exists) res.json({ data: docRef.data(), id: docRef.id });
	else res.status(ErrorCode.NOT_FOUND_404).send(`The token with the id ${tokenId} doesn't exists.`);
});

router.get('/tokens', async (req, res) => {
	const tokenIdsString = req.query.tokenIds;

	if (!tokenIdsString)
		return res.status(ErrorCode.BAD_REQUEST_400).send('Please provider token ids.');

	const tokenIds = JSON.parse(tokenIdsString as string);

	let snapshot;
	try {
		snapshot = await req.db
			.collection(config.firebase.collectionNames.tokens)
			.where(firestore.FieldPath.documentId(), 'in', tokenIds)
			.get();
	} catch (e) {
		console.error(e);
		return res.status(ErrorCode.INTERNAL_SERVER_ERROR_500).send({
			success: false,
			message: `Failed to retrieve tokens with the ids ${tokenIds}.`,
		});
	}

	const docs: firestore.DocumentData[] = [];
	snapshot.forEach((doc) => {
		docs.push(doc.data());
	});

	res.send(docs);
});

router.post('/token', async (req, res) => {
	const { description, external_url, image, name, attributes } = req.body;
	console.log(req.body);

	if (!description || !external_url || !image || !name || !attributes)
		return res
			.status(ErrorCode.BAD_REQUEST_400)
			.send(
				'Please pass these following properties with the body: description, external_url, image, name, attributes',
			);

	let doc;
	try {
		const docRef = await req.db.collection(config.firebase.collectionNames.tokens).add({
			description,
			external_url,
			image,
			name,
			attributes,
		});
		doc = await docRef.get();
	} catch (e) {
		return res.status(ErrorCode.INTERNAL_SERVER_ERROR_500).send('Failed to create a token');
	}

	res.json(doc.data());
});

router.patch('/token', async (req, res) => {
	//body contains => traitIds, masterId
	const { traitIds, masterId } = req.body;

	if (!traitIds || !masterId)
		return res
			.status(ErrorCode.BAD_REQUEST_400)
			.send('Please provide following properies on body: traitIds & masterId');

	const masterDocRef = req.db
		.collection(config.firebase.collectionNames.tokens)
		.doc(masterId.toString());

	const masterDoc = await masterDocRef.get();
	if (!masterDoc.exists)
		return res
			.status(ErrorCode.NOT_FOUND_404)
			.send(`Master with the tokenId ${masterId} not found`);

	const baseUrl =
		'https://algobits.mypinata.cloud/ipfs/QmWv6JsEV77UhzG6hLMjczuZ5seAiRN6TcGNRHg5JwR2KD/';

	const imageUrls = traitIds.map((traitId: number) => `${baseUrl}/${traitId}.png`);
	const imageCompositeList = [];

	try {
		for (let i = 0; i < imageUrls.length; i++) {
			const imageBuffer = (await axios({ url: imageUrls[i], responseType: 'arraybuffer' }))
				.data as Buffer;
			imageCompositeList.push({ input: imageBuffer });
		}
	} catch (e) {
		console.error(`Failed to downloading images${e}`);
		return res.status(ErrorCode.INTERNAL_SERVER_ERROR_500).send('Failed to download remotely');
	}

	// sharp.cache(false);

	try {
		await sharp({
			create: {
				width: 1200,
				height: 1200,
				channels: 4,
				background: { r: 255, g: 255, b: 255, alpha: 0 },
			},
		})
			.composite(imageCompositeList)
			.toFile('./composite.png');
	} catch (e) {
		console.log(`Failed composing images with sharp ${e}`);
		return res
			.status(ErrorCode.INTERNAL_SERVER_ERROR_500)
			.send('Failed composing images with sharp');
	}

	const readableStreamForFile = fs.createReadStream('./composite.png');

	// upload to ipfs
	let fileInfo;
	try {
		fileInfo = await pinata.pinFileToIPFS(readableStreamForFile, {
			pinataMetadata: { name: `Composition of following token ids ${traitIds.join(',')}` },
		});
	} catch (e) {
		console.error(e);
		return res.status(ErrorCode.INTERNAL_SERVER_ERROR_500).send('Failed to upload a file to ipfs.');
	}
	// get content identifier
	console.log(
		'Update master nft where CID->',
		fileInfo?.IpfsHash,
		' and ',
		'master id -> ',
		masterId,
	);

	// delete composed file
	fs.unlink('./composite.png', (err) => {
		if (err && err.code == 'ENOENT') {
			// file doens't exist
			console.info("File doesn't exist, won't remove it.");
		} else if (err) {
			// other errors, e.g. maybe we don't have enough permission
			console.log(err);
			console.error('Error occurred while trying to remove file');
		} else {
			console.info(`removed`);
		}
	});

	try {
		await masterDocRef.update({
			traitIds: traitIds,
			image: config.pinata.baseUrl + fileInfo?.IpfsHash,
		});
	} catch (e) {
		console.log(e);
		return res
			.status(ErrorCode.INTERNAL_SERVER_ERROR_500)
			.send(`Failed to update master nft with the id ${masterId}.`);
	}

	// update masterNft traitIds, imageURI

	//Upload to ipfs ->

	res.send(fileInfo);
});

export default router;