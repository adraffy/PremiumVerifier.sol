import {
	ABI_CODER,
	EthProver,
	HexAddress,
	encodeRlpBlock,
	solidityFollowSlot,
	verifyAccountState,
	type HexString,
	type HexString32,
	type Provider,
} from "@unruggable/gateways";
import { ETH_REGISTRAR, NAME_WRAPPER } from "../test/constants.ts";
import { namehash, solidityPackedKeccak256 } from "ethers/hash";

export async function generateProof(
	provider: Provider,
	blockNumber: bigint,
	labelHash: HexString32,
	deployments: {
		ethRegistrar?: HexAddress;
		nameWrapper?: HexAddress;
	} = {}
): Promise<HexString> {
	const {
		ethRegistrar = ETH_REGISTRAR.address,
		nameWrapper = NAME_WRAPPER.address,
	} = deployments;
	const prover = new EthProver(provider, blockNumber);
	const prover0 = new EthProver(provider, blockNumber - 1n);
	// struct Proof {
	//     uint256 blockNumber;
	//     bytes32 labelHash;
	//     bytes blockHeader;
	//     bytes blockHeader0;
	//     ExpiryProof expiry;
	//     ExpiryProof expiry0;
	//     OwnerProof owner0;
	// }
	const v = await Promise.all([
		blockNumber,
		labelHash,
		(async () => encodeRlpBlock(await prover.fetchBlock()))(),
		(async () => encodeRlpBlock(await prover0.fetchBlock()))(),
		expiryProof(prover),
		expiryProof(prover0),
		ownerProof(prover0),
	]);
	return ABI_CODER.encode(
		[
			"(uint256, bytes32, bytes, bytes, (bytes, bytes), (bytes, bytes), (bytes, bytes, bytes))",
		],
		[v]
	);
	async function expiryProof(p: EthProver) {
		const proof = await p.getProofs(ethRegistrar, [
			solidityFollowSlot(ETH_REGISTRAR.slots.expiries, labelHash),
		]);
		return [
			EthProver.encodeProof(proof.accountProof),
			EthProver.encodeProof(proof.storageProof[0].proof),
		];
	}
	async function ownerProof(p: EthProver) {
		const node = solidityPackedKeccak256(
			["bytes32", "bytes32"],
			[namehash("eth"), labelHash]
		);
		const [proof, wrapperProof] = await Promise.all([
			p.getProofs(ethRegistrar, [
				solidityFollowSlot(ETH_REGISTRAR.slots.owners, labelHash),
			]),
			p.getProofs(nameWrapper, [
				0n,
				solidityFollowSlot(NAME_WRAPPER.slots.tokens, node),
			]),
		]);
		return [
			EthProver.encodeProof(proof.storageProof[0].proof),
			EthProver.encodeProof(wrapperProof.accountProof),
			EthProver.encodeProof(wrapperProof.storageProof[0].proof),
		];
	}
}
