export function zip(files: Array<{ name: string; data: string; mode?: number }>) {
	const local: Buffer[] = [],
		central: Buffer[] = [];
	let offset = 0;
	for (const file of files) {
		const name = Buffer.from(file.name),
			data = Buffer.from(file.data);
		let crc = 0xffffffff;
		for (const byte of data) {
			crc ^= byte;
			for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
		}
		crc = (crc ^ 0xffffffff) >>> 0;
		const header = Buffer.alloc(30);
		header.writeUInt32LE(0x04034b50);
		header.writeUInt16LE(20, 4);
		header.writeUInt32LE(crc, 14);
		header.writeUInt32LE(data.length, 18);
		header.writeUInt32LE(data.length, 22);
		header.writeUInt16LE(name.length, 26);
		local.push(header, name, data);
		const directory = Buffer.alloc(46);
		directory.writeUInt32LE(0x02014b50);
		directory.writeUInt16LE(0x314, 4);
		directory.writeUInt16LE(20, 6);
		directory.writeUInt32LE(crc, 16);
		directory.writeUInt32LE(data.length, 20);
		directory.writeUInt32LE(data.length, 24);
		directory.writeUInt16LE(name.length, 28);
		directory.writeUInt32LE(((file.mode ?? 0o100644) << 16) >>> 0, 38);
		directory.writeUInt32LE(offset, 42);
		central.push(directory, name);
		offset += header.length + name.length + data.length;
	}
	const directory = Buffer.concat(central),
		end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50);
	end.writeUInt16LE(files.length, 8);
	end.writeUInt16LE(files.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...local, directory, end]);
}
