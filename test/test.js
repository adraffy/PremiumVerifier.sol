import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ethers } from "ethers";
import { Foundry } from "@adraffy/blocksmith";
import { generateProof } from "../src/prover.js";

const label = "raffy";
const ONE_DAY = 86400;
const ONE_YEAR = 365 * ONE_DAY;

const foundry = await Foundry.launch({ infoLog: true });
try {
	const ensRegistry = await foundry.deploy({
		import: "@ensdomains/contracts/registry/ENSRegistry.sol",
	});

	// note: this was compiled with an super old version of solc/oz
	// when compiled against oz4+ the storage layout is different
	// using the deployed mainnet bytecode instead
	// https://etherscan.io/address/0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85
	const ethRegistrar = await foundry.deploy({
		bytecode: await readFile(
			new URL("./ethRegistrarCode.txt", import.meta.url),
			"utf8"
		),
		args: [ensRegistry.target, ethers.namehash("eth")],
		abi: await foundry
			.resolveArtifact({
				import: "@ensdomains/contracts/ethregistrar/BaseRegistrarImplementation.sol",
			})
			.then((x) => x.abi),
	});

	// assign "eth" to eth registrar
	await foundry.confirm(
		ensRegistry.setSubnodeRecord(
			ethers.ZeroHash,
			ethers.id("eth"),
			ethRegistrar,
			ethers.ZeroAddress,
			0
		)
	);

	// setup addr.reverse registrar
	const reverseRegistrar = await foundry.deploy({
		import: "@ensdomains/contracts/reverseRegistrar/ReverseRegistrar.sol",
		args: [ensRegistry],
	});

	// assign "addr.reverse" to reverse registrar
	await foundry.confirm(
		ensRegistry.setSubnodeRecord(
			ethers.ZeroHash,
			ethers.id("reverse"),
			foundry.wallets.admin.address,
			ethers.ZeroAddress,
			0
		)
	);
	await foundry.confirm(
		ensRegistry.setSubnodeRecord(
			ethers.namehash("reverse"),
			ethers.id("addr"),
			reverseRegistrar,
			ethers.ZeroAddress,
			0
		)
	);

	// setup an "open" resolver for primary names
	const fakeNameResolver = await foundry.deploy(`contract FakeNameResolver {
		function setName(bytes32 node, string calldata name) external {
			// do nothing
		}
	}`);
	await foundry.confirm(
		reverseRegistrar.setDefaultResolver(fakeNameResolver)
	);

	// setup name wrapper
	const nameWrapper = await foundry.deploy({
		import: "@ensdomains/contracts/wrapper/NameWrapper.sol",
		args: [ensRegistry, ethRegistrar, ethers.ZeroAddress],
	});

	// setup constant usd oracle
	const ethPrice = 4000;
	const fakeUSDOracle = await foundry.deploy(`contract FakeUSDOracle {
		function latestAnswer() external view returns (int256) {
			return ${Math.round(ethPrice)} * 1e8;
		}
	}`);

	// setup exponential price oracle using constant usd oracle
	const priceOracle = await foundry.deploy({
		import: "@ensdomains/contracts/ethregistrar/ExponentialPremiumPriceOracle.sol",
		args: [
			fakeUSDOracle,
			[0n, 0n, 20294266869609n, 5073566717402n, 158548959919n], // $/sec for 720, 160, 5
			100000000000000000000000000n, // 100m$
			21, // days
		],
	});

	// setup wrapped controller
	const wrappedController = await foundry.deploy({
		import: "@ensdomains/contracts/ethregistrar/ETHRegistrarController.sol",
		args: [
			ethRegistrar,
			priceOracle,
			0, // min commit (bypassed)
			1, // max commit
			reverseRegistrar,
			nameWrapper,
			ensRegistry,
		],
	});

	// add wrapped controller and ourselves as controllers
	await foundry.confirm(ethRegistrar.addController(wrappedController));
	await foundry.confirm(ethRegistrar.addController(foundry.wallets.admin));

	// setup verifier
	const verifier = await foundry.deploy({
		file: "PremiumVerifier",
		args: [ethRegistrar, nameWrapper, priceOracle],
	});

	// register name
	await foundry.confirm(
		ethRegistrar.register(
			ethers.id(label),
			foundry.wallets.admin.address,
			1n
		)
	);

	// wait for name to go into premium
	const GRACE_PERIOD = BigInt(await ethRegistrar.GRACE_PERIOD());
	await foundry.nextBlock({ sec: GRACE_PERIOD + BigInt(15 * ONE_DAY) }); // 0-21 days

	// ensure it's in premium
	await assert.rejects(() => ethRegistrar.ownerOf(ethers.id(label)));
	assert(await ethRegistrar.available(ethers.id(label)));
	assert(await wrappedController.available(label));

	// double check: non-zero premium
	const { premium } = await wrappedController.rentPrice(label, ONE_YEAR);
	assert(premium > 0);

	// register name again
	const receipt = await foundry.confirm(
		ethRegistrar.register(
			ethers.id(label),
			foundry.wallets.admin.address,
			ONE_YEAR
		)
	);

	// wait a bit
	await foundry.nextBlock({ sec: 300 });

	// generate a proof at the block of the premium registration
	const proof = await generateProof(
		foundry.provider,
		BigInt(receipt.blockNumber),
		ethers.id(label),
		{
			ethRegistrar: ethRegistrar.target,
			nameWrapper: nameWrapper.target,
		}
	);

	const gas = await verifier.verifyPremiumPurchase.estimateGas(proof);
	const [owner0, premium2] = await verifier.verifyPremiumPurchase(proof);

	console.log({ gas, owner0, premium, premium2 });

	// TODO: wrapped example
	// TODO: prove tx inclusion?
} finally {
	await foundry.shutdown();
}
